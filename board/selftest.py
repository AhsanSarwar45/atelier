#!/usr/bin/env python3
"""What the board's hooks do, exercised without a board.

`bc.bd` is replaced by a recorder, so every command a hook would issue is
collected rather than run: these cases leave nothing behind on the board, which
is what stopped this project keeping self-tests before.

Run: python3 scripts/board/selftest.py
"""
import datetime
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

# A git hook exports these as absolute paths to the repository being committed
# to, and every git command run below inherits them — so the throwaway checkouts
# these cases build would never be built and their commits, branches and
# checkouts would land on the real one instead. Cleared once, for the whole run,
# before anything shells out (mch-mkp.56). The cases that test these settings
# pass them in the command they are judging, not in this environment.
for _pointed in ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                 "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES"):
    os.environ.pop(_pointed, None)

HOME = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, HOME)
sys.path.insert(0, os.path.join(HOME, "hooks"))
sys.path.insert(0, os.path.join(HOME, "board"))
import project  # noqa: E402
import sections as bars  # noqa: E402

# The project whose declaration this run answers for. Every case below that
# touches a card's shape, a pour or a commit is that project's own; the rest are
# the machinery's and are the same everywhere. Named rather than assumed, so the
# suite can be run against each declaration in turn.
WHICH = next((a for a in sys.argv[1:] if not a.startswith("-")), None)
ROOT = project.registry().get(WHICH) or os.path.abspath(WHICH or os.getcwd())
DECL = bars.use(ROOT)
AREA = DECL.areas[0] if DECL.areas else "board"
LAST_AREA = DECL.areas[-1] if DECL.areas else AREA


def pin():
    """Point the bars back at the project this run is for.

    They answer for one declaration at a time, which is right for a gate or a
    tool — one process, one checkout. This run is the only place that is not
    true: every gate it exercises and every tool it loads switches them to the
    checkout it was handed. Unpinned, a case afterwards is written against
    somebody else's prefix and refuses a line that is in fact correct.
    """
    bars.use(ROOT)


def hook(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), os.path.join(HOME, "hooks", name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


touch = hook("board-touch")
gate = hook("board-gate")
status = hook("board-status-gate")
reading = hook("habit-reading")
runner = touch.run
spine = runner.spine

# Every fixture here carries a `tst-` id — a prefix no project issues, because a
# fixture is the machinery's and not any project's. The gates read a command's
# cards out of this. Pinned rather than asked: by the time a case runs the board
# is a recorder answering fixtures, and a state directory with no cached answer
# would learn one from it and keep it for the real hooks.
FIXTURE = "tst"
status.bc.prefix = lambda root: FIXTURE
status.bc.prefixes = lambda root: [FIXTURE]

# What the child run below is told, so it does not spawn one of its own.
CHILD = "--switched-off"

# A job with nothing left to build: every piece closed and nothing standing where
# the reading is. The reading has no card of its own, so what says whether the job
# still owes one is the goal's own signature and the commits it covers —
# scripts/board/reading.py, and the `notes`/`shas` arguments below are both halves
# of it.
GOAL = {"id": "g", "priority": 1, "labels": ["job", "area:board", "kind:feature"],
        "metadata": {"spine": "worktree,work,verify,review,record,land",
                     "area": "board", "kind": "feature"}}
ROWS = [
    {"id": "g.1", "status": "closed", "labels": ["step:worktree", "of:g"]},
    {"id": "g.2", "status": "closed", "labels": ["step:work", "of:g"]},
    {"id": "g.3", "status": "closed", "labels": ["step:work", "of:g"]},
    {"id": "g.4", "status": "closed", "labels": ["step:verify", "of:g"]},
]
SIGNED = "reviewed-by: review-g\nread-commits: %s"
# Two readings already on the goal, which is every reading a job ever gets. The
# second covers less than the first because it is shown only what the first was
# not (board/reading.py `unread`).
TWICE = (SIGNED % "a1c0ffee") + "\n\n" + (SIGNED % "b2deadbe")

# The claim readers are sent under, and the fixture job the cases below claim. It
# carries the fixture prefix like every other, so a real job can never collide
# with it in the shared directory the claims live in.
inflight = runner.inflight
HELD = FIXTURE + "-reading"
# The genuine sending, held from before any case runs: the cases above stand a
# recorder in its place and leave it there, and this one is about the sending.
REAL_FIRE = runner.fire
REAL_POPEN = subprocess.Popen
# The genuine search for a job's commits, held for the same reason: the cases
# about the run stand a recorder in its place and leave it there, and the case
# about the search itself is about the real one.
REAL_COMMITS = runner.reading.commits
# What decides how many readings a job gets, asked of directly where a case is
# about the count itself rather than about what the count makes the run do.
reading_lib = runner.reading
# The words that tell a reader nobody comes after it. Named here so the case reads
# the reader's own sentence and not a copy of it that can drift.
LAST_ROUND = "last reading this job will ever get"
# A job whose work is six cards rather than two: the shape one command closes at
# once, and the shape that sent six readers at one goal.
CROWD = ["g.%d" % n for n in range(10, 16)]
CROWDED = ([{"id": "g.1", "status": "closed", "labels": ["step:worktree", "of:g"]}]
           + [{"id": i, "status": "closed", "labels": ["step:work", "of:g"]}
              for i in CROWD])


def pretend_reader(where, goal_id):
    """A process that answers to a reader's name, for cases about the claim.

    The claim identifies the process it is holding for rather than counting
    seconds at it, so a stand-in has to be one — a live number of any other
    process is exactly what it must not accept.
    """
    stub = os.path.join(where, "review")
    if not os.path.exists(stub):
        with open(stub, "w") as fh:
            fh.write("import time\ntime.sleep(300)\n")
    # The genuine one: the case below stands its own in the same place, and
    # `subprocess` is one module however many names reach it.
    return REAL_POPEN([sys.executable, stub, goal_id])


def storm(claimed=False):
    """How many readers one command closing six cards of one job sends.

    The reader's launch is recorded rather than run — a real one is another
    `claude` — but the claim itself is real, so what is counted is the guard and
    not a stand-in for it.
    """
    goal = dict(GOAL, status="in_progress", notes="",
                metadata=dict(GOAL["metadata"],
                              spine="worktree,work,review,record,land"))
    fired = []

    def recorder(args, root=None):
        if args[:2] == ["list", "--parent"]:
            return True, json.dumps(CROWDED)
        if args[0] == "show":
            return True, json.dumps(goal if args[1] == "g"
                                    else next(r for r in CROWDED if r["id"] == args[1]))
        if args[:2] == ["gate", "list"]:
            return True, "[]"
        return True, "{}"

    pretend = tempfile.mkdtemp()
    live = []

    class Reader:
        def __init__(self, cmd, **kw):
            live.append(pretend_reader(pretend, cmd[-1]))
            self.pid = live[-1].pid
            fired.append(cmd[-1])

    was, runner.subprocess.Popen = runner.subprocess.Popen, Reader
    keep_bd, keep_c, keep_w = runner.bc.bd, runner.reading.commits, runner.reading.wrote
    keep_fire, runner.fire = runner.fire, REAL_FIRE
    runner.bc.bd = recorder
    runner.reading.commits = lambda gid, root: ["a1c0ffee"]
    runner.reading.wrote = lambda gid, root: {"someone"}
    if not claimed:
        inflight.clear("g")
    try:
        for cid in CROWD:
            runner.advance(cid, ROOT)
    finally:
        runner.subprocess.Popen = was
        runner.bc.bd, runner.reading.commits, runner.reading.wrote = keep_bd, keep_c, keep_w
        runner.fire = keep_fire
        for p in live:
            p.kill()
            p.wait()
        shutil.rmtree(pretend, ignore_errors=True)
        if not claimed:
            inflight.clear("g")
    return len(fired)


def script(name):
    """One of board's own commands, which carry no suffix to import by."""
    spec = importlib.util.spec_from_loader(
        "board_" + name, importlib.machinery.SourceFileLoader(
            "board_" + name, os.path.join(HOME, "board", name)))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # A board command reads its own project as it loads, which leaves the bars
    # answering for whatever checkout this case was standing in (mch-m1t.19).
    pin()
    return mod


def release_sends(signed, shas, wrote=("someone",), rows=None, notes=None):
    """How many readers letting go of a claim sends, given what this one did.

    `wrote` carries the reader's own name in the case where the job counts it
    among the hands that wrote it, and `rows` the case where this very reading
    filed work that is now open again. `notes` carries the receipts already on the
    goal, for the case where this reading was the last one the job gets.
    """
    rv = script("review")
    fired = []
    inflight.clear("g")
    inflight.take("g")
    inflight.name("g", os.getpid())
    # A reader that never signed left the goal exactly as it found it, which is
    # what makes the job still want one — and what would send another at it.
    goal = dict(GOAL, status="in_progress",
                notes=notes if notes is not None else (SIGNED % "a1" if signed else ""),
                metadata=dict(GOAL["metadata"],
                              spine="worktree,work,review,record,land"))
    keep = (rv.READING, rv.SIGNED, rv.running.card, rv.running.children,
            rv.reading.commits, rv.reading.wrote, rv.running.fire)
    rv.READING, rv.SIGNED = "g", signed
    rv.running.card = lambda cid, root: goal
    rv.running.children = lambda gid, root: list(CROWDED if rows is None else rows)
    rv.reading.commits = lambda gid, root: list(shas)
    rv.reading.wrote = lambda gid, root: set(wrote)
    rv.running.fire = lambda gid, root: fired.append(gid)
    try:
        rv.release()
    finally:
        (rv.READING, rv.SIGNED, rv.running.card, rv.running.children,
         rv.reading.commits, rv.reading.wrote, rv.running.fire) = keep
        inflight.clear("g")
    return len(fired)


class Reached(Exception):
    """Raised where a case stands in for the reading itself.

    The reading is a whole `claude` session minutes long, so no case can run one.
    What a case can ask is whether the run got as far as starting one, and this
    is how the answer comes back.
    """


# Where a reader that is already out says it is writing, for the case that finds
# one and has to point at it.
BUSY_LOG = "/nowhere/g.already.run/run.log"
# Where the run that spawned a detached copy redirected that copy's console. It is
# told to the copy, because the copy cannot see its own redirection.
COPY_LOG = "/nowhere/g.copy.run/run.log"


def hands_off(detached, rerun=True, busy=None, notes="", shas=("a1c0ffee",)):
    """What a reading fired by hand does: spawn a copy of itself, or read.

    Fired by hand it used to do the reading in the caller's own shell, and the
    agent that asked for it could answer nothing for the minutes that took
    (bw-k0w). What comes back is the spawn — its command line and what it was
    told — the goal the reading was actually started on, and the line the caller
    was left with.

    `detached` is the copy's side of the same run: told it is the copy, it must
    read rather than hand off again, because a reader that hands off to a reader
    is a reading nobody ever does. `busy` is the pid of a reader already out on
    the job, which this run must find and stand down from. `notes` and `shas` are
    the two halves of whether a reading is owed at all: what the goal carries a
    signature for, and what it has landed since. The console the claim carries
    when the run stops comes back too: a claim named with none leaves the next
    firing pointing whoever asked at nowhere (bw-5e8.10).
    """
    rv = script("review")
    goal = dict(GOAL, status="in_progress", notes=notes)
    spawned = []
    read = []

    class Copy:
        def __init__(self, cmd, env=None, **kw):
            spawned.append((list(cmd), dict(env or {})))
            self.pid = os.getpid()

    def reads(prompt, actor, goal_id):
        read.append(goal_id)
        raise Reached()

    where = tempfile.mkdtemp()
    said = io.StringIO()
    rv.bd = lambda args, actor=None, must=True: json.dumps(goal)
    rv.changes = lambda shas, goal_id: ([], "")
    rv.run_log = lambda goal_id: where
    rv.run_reviewer = reads
    rv.reading.commits = lambda gid, root: list(shas)
    rv.reading.wrote = lambda gid, root: {"someone"}
    keep_popen, subprocess.Popen = subprocess.Popen, Copy
    keep_argv, sys.argv = sys.argv, ["review", "g"] + (["--rerun"] if rerun else [])
    keep_out, sys.stdout = sys.stdout, said
    if detached:
        os.environ[inflight.DETACHED] = "1"
        os.environ[inflight.CONSOLE] = COPY_LOG
    inflight.clear("g")
    if busy:
        inflight.take("g")
        inflight.name("g", busy, BUSY_LOG)
    try:
        rv.main()
    except Reached:
        pass
    finally:
        subprocess.Popen = keep_popen
        sys.argv, sys.stdout = keep_argv, keep_out
        os.environ.pop(inflight.DETACHED, None)
        os.environ.pop(inflight.CONSOLE, None)
        console = inflight.console("g")
        inflight.clear("g")
        shutil.rmtree(where, ignore_errors=True)
    return spawned, read, said.getvalue(), console


def fires_marked():
    """The command line and the settings the board's own firing sends a reader on.

    The board fires its readers already detached, so the reader it sends must be
    told it is the copy: unmarked, it would hand off to a copy of itself and the
    board would be waiting on a run that spawned another run (bw-k0w.5).
    """
    told = {}

    class Reader:
        def __init__(self, cmd, env=None, **kw):
            told["cmd"], told["env"] = list(cmd), dict(env or {})
            self.pid = os.getpid()

    keep_popen, runner.subprocess.Popen = runner.subprocess.Popen, Reader
    keep_fire, runner.fire = runner.fire, REAL_FIRE
    # A reader sent from inside another reader inherits that one's run directory
    # unless the sending clears it, and would write its attempts on top of them.
    os.environ[inflight.RUN_DIR] = "/nowhere"
    inflight.clear("g")
    try:
        runner.fire("g", ROOT)
    finally:
        runner.subprocess.Popen = keep_popen
        runner.fire = keep_fire
        os.environ.pop(inflight.RUN_DIR, None)
        inflight.clear("g")
    return told


# A job held shut by its own reading, as the board answers `gate list` for it.
READING_GATE = [{"id": "g-gate", "status": "open", "issue_type": "gate",
                 "title": runner.GATE_TITLE}]


def run(goal_status, rows=None, notes="", shas=("a1c0ffee", "b2deadbe"),
        wrote=("someone",), gates=()):
    """The commands the hook issues when g.3, the last work item, closes.

    `gates` is what is holding the job shut at that moment — empty for a job that
    has not been read yet, the reading's own gate for a job waiting on a reader
    that is not coming.
    """
    goal = dict(GOAL, status=goal_status, notes=notes)
    rows = ROWS if rows is None else rows
    issued = []

    def recorder(args, root=None):
        issued.append(" ".join(args))
        if args[:2] == ["list", "--parent"]:
            return True, json.dumps(rows)
        if args[:2] == ["gate", "list"]:
            return True, json.dumps(list(gates))
        if args[0] == "show":
            return True, json.dumps(goal if args[1] == "g" else rows[2])
        return True, "{}"

    touch.bc.bd = recorder
    # The job's commits and the names that wrote it are the two things the board
    # cannot answer without a repository, so the case supplies both.
    runner.reading.commits = lambda gid, root: list(shas)
    runner.reading.wrote = lambda gid, root: set(wrote)
    runner.fire = lambda gid, root: issued.append("READ " + gid)
    runner.advance("g.3", ROOT)
    return issued


def pours_with(name):
    """What the pour says to a job declaring it lands in `name`.

    Run as the command rather than imported, because the module IS the command —
    it parses its arguments and pours as it loads. What is judged is the refusal
    and its exit, so nothing here reaches the board: a name the project declares
    is carried past the landing check and refused for the next thing wrong with
    it, which says the flag let it through without a card being made.
    """
    out = subprocess.run(
        [os.path.join(HOME, "board", "job"), "new", "--lands", name,
         "--what", "Fix the lamp", "--evidence", "the manager said so today ok",
         "--done", "python3 x.py reports 0 failures", "--not", "the board",
         "--area", AREA, "--kind", "bug", "--judge", "agent"],
        cwd=ROOT, capture_output=True, text=True, timeout=120)
    return out.returncode, (out.stdout + out.stderr)


def told_round(notes):
    """The line a reader is handed about which of the job's readings it is doing.

    Read off the prompt itself rather than off a flag, because the flag is not
    what the reader acts on: a reader told nothing leaves its point for the round
    after it, and on the last reading there is no round after it.
    """
    rv = script("review")
    goal = dict(GOAL, status="in_progress", notes=notes)
    return rv.ask(goal, ["a1c0ffee in /nowhere"], "a diff",
                  rv.reading.final(goal))


def reads_elsewhere():
    """What a reading finds when the job's every commit is in another checkout.

    The two checkouts are real and so is the commit, because the whole fault was
    a search that ran in the wrong directory: a recorder standing in for `git log`
    would have passed the whole time it was broken (mch-4cl). What is stood in for
    is the registry — a case cannot register a project on the machine it runs on.

    Comes back as (what a reading counts, what a close may be judged against, what
    the goal's own label says): the first must find the commit, the second must
    not have widened, and the third must be empty, or the case is passing on the
    label rather than in spite of it.
    """
    tmp = tempfile.mkdtemp()
    here, there = os.path.join(tmp, "here"), os.path.join(tmp, "there")

    def build(where, subject):
        os.makedirs(where)
        for args in (("init", "-q", "-b", "main", "."),
                     ("config", "user.email", "selftest@example.com"),
                     ("config", "user.name", "selftest"),
                     ("commit", "-q", "--allow-empty", "-m", subject)):
            subprocess.run(["git"] + list(args), cwd=where, capture_output=True)

    build(here, "chore(board): nothing of this job")
    build(there, "fix(board): tst-x.2 the change this job made, landed elsewhere")
    bc = runner.reading.bc
    keep_e, keep_d = bc.elsewhere, bc.declared
    keep_c, runner.reading.commits = runner.reading.commits, REAL_COMMITS
    # Registered and declared, and the goal wears no landing label — which is the
    # state every real job is in, since nothing writes that label.
    bc.elsewhere = lambda root: {"there": (there, "main")}
    bc.declared = lambda cid, root: []
    try:
        found = runner.reading.commits("tst-x", here)
        judged = [w for w, _ in bc.landings(here, "tst-x")]
        labelled = bc.declared("tst-x", here)
    finally:
        bc.elsewhere, bc.declared = keep_e, keep_d
        runner.reading.commits = keep_c
        shutil.rmtree(tmp, ignore_errors=True)
    return found, judged, labelled


def makes_card(sid):
    """Whether the run would create a card for this position of the playbook."""
    issued = []

    def recorder(args, root=None):
        issued.append(" ".join(args))
        return True, "{}"

    runner.bc.bd = recorder
    goal = {"id": "g", "priority": 1, "status": "in_progress", "labels": ["job"],
            "metadata": {"area": "board", "kind": "chore"}}
    runner.open_next([sid], set(), "g", goal, goal["metadata"], ROOT)
    return any(a.startswith("create") for a in issued)


# A job at the end of its order. Closing the last step is what puts a job the
# manager signs into his column; it is already in the game by then.
LANDED = [
    {"id": "j.1", "status": "closed", "labels": ["step:worktree", "of:j"]},
    {"id": "j.2", "status": "closed", "labels": ["step:work", "of:j"]},
    {"id": "j.3", "status": "closed", "labels": ["step:land", "of:j"]},
]


def landing(judge):
    """The commands the hook issues when j.3, the job's last step, closes."""
    goal = {"id": "j", "status": "in_progress", "priority": 1,
            "labels": ["job", "area:board", "kind:feature"],
            "metadata": {"spine": "worktree,work,land", "area": "board",
                         "kind": "feature", "judge": judge,
                         "judge_why": "the six columns on his own screen"}}
    issued = []

    def recorder(args, root=None):
        issued.append(" ".join(args))
        if args[:2] == ["list", "--parent"]:
            return True, json.dumps(LANDED)
        if args[0] == "show":
            return True, json.dumps(goal if args[1] == "j" else LANDED[2])
        return True, "{}"

    touch.bc.bd = recorder
    runner.advance("j.3", ROOT)
    return issued


def refusal(cmd, card, family=None):
    """What the status gate says to `cmd`, with every card it names looking like this.

    `family` answers `bd show` per id, for a case where the card being closed and
    the goal it belongs to have to differ.
    """
    def recorder(args, root=None):
        if args[0] == "show":
            return True, json.dumps((family or {}).get(args[1]) or dict(card, id=args[1]))
        return True, "[]"

    status.bc.bd = recorder
    status.bc.reviewing = lambda: ""
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": ROOT, "tool_input": {"command": cmd}}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        status.main()
    finally:
        sys.stdout = keep
    said = out.getvalue().strip()
    if not said:
        return ""
    return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"]


# One job in both shapes a work item is poured in: j.2.1 under the build step, and
# j.4 straight under the goal. j's spine mentions build, so j.2 also carries the
# goal-wide allowance left standing for jobs poured before the 2026-08-13 ruling.
FAMILY = {
    "j": {"id": "j", "labels": ["job", "area:board"],
          "metadata": {"spine": "worktree,build,land"}},
    "j.2": {"id": "j.2", "labels": ["step:build", "of:j"]},
    "j.2.1": {"id": "j.2.1", "labels": ["area:board", "kind:bug"]},
    "j.4": {"id": "j.4", "labels": ["area:board", "kind:bug"]},
}


def names(cid, blind=False):
    """The commit names the close gate would accept as this card's landing.

    `blind` is the fault: the board answers nothing about any ancestor, which is
    the same answer the gate had before the walk existed and the one it gets back
    if the walk is removed. A case that stays green blind is proving nothing.
    """
    status.bc.bd = lambda args, root=None: (
        (True, json.dumps({} if blind else FAMILY.get(args[1], {})))
        if args[0] == "show" else (True, "[]"))
    return status.landing_names(cid, FAMILY[cid], ROOT)


# The stop gate, over one turn: three project files edited, and the card that was
# standing over them either closed before the turn ended or never existed. T is the
# turn's start; the edits land at T+10..T+30 and the turn ends at T+50.
T = 1000.0
EDITS = [{"p": "scripts/hooks/board-gate.py", "t": T + 10},
         {"p": "scripts/board/spine.py", "t": T + 20},
         {"p": "docs/board.md", "t": T + 30}]


def stopping(claims, closed, held, asked=True):
    """Whether the turn is allowed to end.

    `asked` stands a question to the manager in the turn, which is what isolates
    the edits-under-a-card refusal from the unfinished-work one: holding a card at
    the end of a turn is itself a refusal (docs/board.md#4f-when-a-session-may-stop),
    and every case here but the unfinished-work ones is about the other rule.
    """
    state = {"edits": EDITS, "created": [], "last_stop": T,
             "claims": claims, "closed": closed,
             "asked": T + 45 if asked else 0}
    gate.bc.load = lambda sid: dict(state)
    gate.bc.save = lambda sid, s: None
    gate.bc.now = lambda: T + 50
    gate.bc.held = lambda name, root=None: list(held)
    gate.bc.machine_name = lambda root=None: "someone"
    gate.bc.reviewing = lambda: ""
    gate.bc.actor = lambda sid, cwd: "test-session"
    sys.stdin = io.StringIO(json.dumps({
        "session_id": "selftest", "cwd": ROOT,
        "last_assistant_message": "done http://127.0.0.1:3008/api/reports/page?x=1",
    }))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        gate.main()
    finally:
        sys.stdout = keep
    return not out.getvalue().strip()


MERGE_GATE = os.path.join(HOME, "hooks", "board-merge-gate.py")

# Every route onto a line, and what a project that has said nothing about itself
# must be told. Standing on a working line throughout: which line the command
# WRITES TO is the whole question, so the same word appears on both sides.
ROUTES = (
    ("ALLOWED", "git merge staging"),
    ("ALLOWED", "git rebase staging"),
    ("ALLOWED", "git rebase main"),
    ("ALLOWED", "git merge --continue"),
    ("ALLOWED", "git merge --abort"),
    ("ALLOWED", "git checkout --ours a.ts"),
    ("ALLOWED", "git add -A"),
    ("ALLOWED", "git commit -m fix"),
    ("ALLOWED", "git push origin feature/mine"),
    # A line whose name ends in a protected word is not that line. Cutting a
    # refspec at its last slash makes both of these unpushable.
    ("ALLOWED", "git push origin fix/main"),
    ("ALLOWED", "git push origin chore/release"),
    ("ALLOWED", "git push origin refs/heads/feature/mine"),
    ("REFUSED", "git checkout staging && git merge feature/mine"),
    # Every line at once takes the protected ones with it, and neither of these
    # spells one out.
    ("REFUSED", "git push --all origin"),
    ("REFUSED", "git push --mirror origin"),
    # The plus that forces a write is not part of a name, and naming the position
    # you stand at names the line you stand on — here a working one.
    ("REFUSED", "git push origin +main"),
    ("REFUSED", "git push origin +feature/mine:main"),
    ("ALLOWED", "git push origin HEAD"),
    # Pointing a shipping line at your own work, in the four spellings that use
    # none of the folding words.
    ("REFUSED", "git checkout -B main"),
    ("REFUSED", "git branch -f main HEAD"),
    ("REFUSED", "git branch -M main"),
    ("REFUSED", "git branch -D staging"),
    ("REFUSED", "git update-ref refs/heads/main HEAD"),
    ("ALLOWED", "git branch -f mywork HEAD"),
    ("ALLOWED", "git checkout -B feature/other"),
    ("ALLOWED", "git reset --hard HEAD~1"),
    # A rename destroys the name it starts from, so renaming a shipping line away
    # is deleting it by another word.
    ("REFUSED", "git branch -m main scratch"),
    ("REFUSED", "git branch -M main scratch"),
    ("ALLOWED", "git branch -m mywork other"),
    # An escaped quote is a character, not the start of a quoted stretch. Read as
    # one, it swallows everything after it — including the push.
    ('REFUSED', 'git commit -m \\" && git push origin main'),
    # A message the shell works out is an ordinary message: what a commit writes
    # to is the line it stands on, whatever its arguments say.
    ("ALLOWED", 'git commit -m "$(date)"'),
    ("ALLOWED", "git pull"),
    ("ALLOWED", "git pull --rebase origin main"),
    # A word in front of a command carries it and is not it. A refusal a prefix
    # walks around is not a refusal.
    ("REFUSED", "env git push origin main"),
    ("REFUSED", "command git push origin main"),
    ("REFUSED", "exec git push origin main"),
    ("REFUSED", "nice -n 10 git push origin main"),
    ("REFUSED", "time git push origin main"),
    ("REFUSED", "setsid git push origin main"),
    ("REFUSED", "stdbuf -oL git push origin main"),
    ("REFUSED", "sudo git push origin main"),
    ("REFUSED", "timeout 60 git push origin main"),
    ("REFUSED", "env GIT_SSH_COMMAND=ssh git push origin main"),
    # A shell handed a command line is handed a command line, and the tool is the
    # tool wherever it is typed from.
    ("REFUSED", 'bash -c "git push origin main"'),
    ("REFUSED", 'sh -c "git push origin main"'),
    # And with the shell's switches bundled, which is how they are actually typed.
    ("REFUSED", 'sh -euc "git push origin main"'),
    ("REFUSED", 'bash -lc "git push origin main"'),
    # Stepping back onto the line you were on before is a step. Read as a switch
    # and dropped, the commit behind it lands on a line nobody looked at.
    ("REFUSED", "git checkout - && git commit -m x"),
    ("REFUSED", "git switch - && git commit -m x"),
    ("REFUSED", "/usr/bin/gh pr merge 412 --squash"),
    # Moving further into the same checkout does not forget which line was
    # stepped onto: a subdirectory of a checkout stands where the checkout does.
    ("REFUSED", "git checkout main && cd sub && git commit -m x"),
    # The second line of a shell call is a command, not the first one's arguments.
    ("REFUSED", "git status\ngit push origin main"),
    # Finishing a fold and then writing to a shipping line is the moment the guard
    # is for, and every mid-fold switch offers the same way past it.
    ("REFUSED", "git rebase --continue && git push origin main"),
    # Stepping onto a shipping line and committing, with and without the quotes
    # that once hid the name.
    ("REFUSED", "git checkout main && git commit -m x"),
    ('REFUSED', 'git checkout "staging" && git commit -m x'),
    ("REFUSED", "git rebase main staging"),
    ("REFUSED", "git push origin HEAD:staging"),
    ("REFUSED", "git push origin main"),
    ("REFUSED", "gh pr merge 412 --squash"),
    # A fetch writes to the line named on the right of a refspec, with no fold and
    # without ever standing on it. Bringing a line down onto the line of the same
    # name is staying current; bringing a different one down onto it is landing.
    ("ALLOWED", "git fetch"),
    ("ALLOWED", "git fetch origin"),
    ("ALLOWED", "git fetch --all --prune"),
    ("ALLOWED", "git fetch origin main:main"),
    ("ALLOWED", "git fetch origin refs/heads/main:refs/heads/main"),
    ("REFUSED", "git fetch . HEAD:main"),
    ("REFUSED", "git fetch origin feature/mine:staging"),
    ("REFUSED", "git fetch origin +HEAD:main"),
    # The raw call that the everyday pull-request merge is built on lands the same
    # piece of work on the same line; asking whether it is merged does not.
    ("REFUSED", "gh api --method PUT repos/scratch/own/pulls/412/merge"),
    # The forge folds one line into another with no waiting piece at all, and
    # points a named line at any commit. Three ways to the same place.
    ("REFUSED", "gh api --method POST repos/scratch/own/merges -f base=main"),
    ("REFUSED", "gh api --method PATCH repos/scratch/own/git/refs/heads/main"),
    ("ALLOWED", "gh api repos/scratch/own/git/refs/heads/main"),
    ("ALLOWED", "gh api --method GET repos/scratch/own/merges"),
    # The file-writing path of the raw call commits straight onto a named line.
    ("REFUSED", "gh api --method PUT repos/scratch/own/contents/README.md "
                "-f branch=main -f message=x -f content=y"),
    ("REFUSED", "gh api -X PUT repos/scratch/own/pulls/412/merge"),
    ("REFUSED", "gh api -XPUT repos/scratch/own/pulls/412/merge"),
    ("REFUSED", "gh api repos/scratch/own/pulls/412/merge -f merge_method=squash"),
    ("ALLOWED", "gh api repos/scratch/own/pulls/412/merge"),
    ("ALLOWED", "gh api repos/scratch/own/pulls/412"),
    ("ALLOWED", "gh api --method GET repos/scratch/own/pulls"),
    # A line worked out by the shell is a line nothing here can read, in every
    # spelling of working it out — the plain variable included. Working it out on
    # one command and pushing it on the next is the two-step form of the same.
    ("REFUSED", "git push origin $BRANCH"),
    ("REFUSED", "BRANCH=main && git push origin $BRANCH"),
    ("REFUSED", "git push origin ${BRANCH}"),
    ("REFUSED", "git push origin ${X:-main}"),
    # A forced step does not only move: it points the line it lands on at where
    # you were standing, so an unreadable name there is an unreadable write.
    ('REFUSED', 'git checkout -B "$(printf main)"'),
    ("REFUSED", "git checkout -B ${X:-main}"),
    ("REFUSED", "git switch -C $LINE"),
    # And a step onto a new line of its own is still a step onto a new line.
    ("ALLOWED", "git checkout -b $NEW"),
    # The brackets of a nested command belong to the command around them. Read as
    # separators they cut this in three, and the piece carrying the verb is thrown
    # away with them — so the push is never seen at all.
    ("REFUSED", "git -C $(pwd)/sub push origin main"),
    # Copying one line over another lands on the name copied TO, in two words and
    # with none of the folding verbs. The long-hand form carries the force switch
    # as well, which would otherwise credit the write to the name copied FROM.
    ("REFUSED", "git branch -C feature/mine main"),
    ("REFUSED", "git branch --copy --force feature/mine main"),
    ("REFUSED", "git branch -c work staging"),
    ("ALLOWED", "git branch -C main feature/other"),
    # A branch command that only lists writes to nothing, so a value the shell
    # works out cannot make it write to a line — and the refusal it used to get
    # talked about pushing, which is not what was typed.
    ("ALLOWED", "git branch --contains $(git rev-parse HEAD)"),
    ("ALLOWED", "git branch --list"),
    # Rebasing your own line onto a base worked out on the spot is the everyday
    # command the design says is always allowed. Only the argument that names the
    # line being REWRITTEN makes a rebase unreadable.
    ("ALLOWED", "git rebase --onto main $(git merge-base main HEAD) feature/mine"),
    ("REFUSED", "git rebase --onto $(echo x) upstream main"),
    ("REFUSED", "git rebase main $(echo staging)"),
    # A line longer than the walk reads is refused rather than half-read: the
    # tail is where the refusal would have been, and padding with harmless
    # commands must not be a way around every rule on the line.
    ("REFUSED", " && ".join(["git status"] * 200 + ["git push origin main"])),
    # A switch's value is not a switch. Read as one, a mid-fold word typed as a
    # message stands the whole command down — and every rule on it with it.
    ("REFUSED", "git push origin main -o --dry-run"),
    # And a value is not one of the command's own arguments either: counted as
    # one, every argument after it is read one place along, and the line a
    # command writes to is read by position.
    ("REFUSED", "git rebase -X ours upstream main"),
    ("ALLOWED", "git rebase -X ours main"),
    ("REFUSED", "git update-ref -m sync refs/heads/main HEAD"),
    ("REFUSED", "git merge -m --abort feature/other && git push origin main"),
    # An optional-value switch standing alone eats nothing. Read as always taking
    # the next word, the remote is swallowed, the line is read as the remote, and
    # a force-push over a shipping line comes out as a push to the agent's own.
    ("REFUSED", "git push --force-with-lease origin main"),
    ("REFUSED", "git push --signed origin main"),
    ("REFUSED", "git rebase -S upstream main"),
    ("REFUSED", "git commit -S -m x && git push origin main"),
    # The long spelling of a switch is the same switch. Refused short and allowed
    # long is the same rewrite, typed differently.
    ("REFUSED", "git switch --force-create main"),
    ("REFUSED", "git checkout --orphan main && git commit -m x"),
    # A substitution RUNS what is inside it, wherever on the line it stands, and
    # so does eval. Kept as one opaque word — which is what keeps the argument
    # count right — the command inside is read by nobody.
    ("REFUSED", "$(git push origin main)"),
    ("REFUSED", "`git push origin main`"),
    ('REFUSED', 'eval "git push origin main"'),
    ("REFUSED", "eval git push origin main"),
    ("REFUSED", "echo $(git push origin main)"),
    ('REFUSED', 'nice -n 10 eval "git push origin main"'),
    # The second checkout does not exist until the first half of the line runs,
    # and the line it will stand on is named right there.
    ("REFUSED", "git worktree add sub/copy main && git -C sub/copy commit -m x"),
    ("REFUSED", "git worktree add -b hot sub/copy && git -C sub/copy push origin main"),
    # The word after the switch is the new line, not the place. Read as the
    # place, the copy is registered nowhere and the ordinary commit that follows
    # is refused for naming a line by running something.
    ("ALLOWED", "git worktree add -b hot sub/copy && git -C sub/copy commit -m x"),
    ("ALLOWED", "git worktree add sub/copy feature/mine && git -C sub/copy commit -m x"),
    # A directory that is no checkout at all has a line nobody here can name.
    ("REFUSED", "git -C sub/nowhere-at-all commit -m x"),
    # Repointing the position by hand is stepping onto a line.
    ("REFUSED", "git symbolic-ref HEAD refs/heads/main && git commit -m x"),
    ("ALLOWED", "git symbolic-ref HEAD refs/heads/feature/other && git commit -m x"),
    # The reason a repointing carries is the value of its switch and not a name
    # of its own. Counted as a name, every name after it moves along one place:
    # the line written to is read as the reason, and the shipping line goes
    # unread (bw-7e8.9).
    ("REFUSED", "git symbolic-ref -m why refs/heads/main refs/heads/x"),
    ("REFUSED", "git symbolic-ref -m why HEAD refs/heads/main && git commit -m x"),
    # Taking the pointer away is a write, and the only one spelled with a single
    # name on it.
    ("REFUSED", "git symbolic-ref --delete refs/heads/main"),
    ("REFUSED", "git symbolic-ref -d refs/heads/main"),
    # A here-document body is what a command is HANDED, not what the shell runs.
    # Writing a script that merely mentions a fold is not folding, and reading it
    # as one refuses the writing of any script that names a git command at all.
    ("ALLOWED", "cat > s.sh <<'EOF'\ngit push origin main\nEOF"),
    ("ALLOWED", "cat > s.sh <<'EOF'\n$(git push origin main)\nEOF"),
    ("ALLOWED", "python3 - <<'PY'\nprint(\"git push origin main\")\nPY"),
    # With the delimiter left unquoted the shell works substitutions out inside
    # the body, and those do run.
    ("REFUSED", "cat > s.sh <<EOF\n$(git push origin main)\nEOF"),
    # An opener is only an opener outside quotes, and only when its closing word
    # arrives. Read anywhere, ordinary text in a message makes every line after
    # it data and the command on that line is judged by nobody.
    ('REFUSED', 'git commit -m "shifted 1 << 2"\ngit push origin main'),
    ('REFUSED', 'git commit -m "see <<EOF in the notes"\ngit push origin main'),
    # With a closing word further down, an opener read inside the message would
    # swallow the push whole rather than falling back to reading everything.
    ('REFUSED', 'git commit -m "see <<EOF here"\ngit push origin main\nEOF'),
    ("REFUSED", "cat <<< here-string\ngit push origin main"),
    ("REFUSED", "cat > s.sh <<'NEVERCLOSED'\ngit push origin main"),
    # The batch form of pointing a line carries every line it writes to in its
    # own input, so the command names none of them.
    ("REFUSED", "git update-ref --stdin <<EOF\nupdate refs/heads/main HEAD\nEOF"),
    # A name fed in from the left of a pipe is the shell settling it at run time,
    # exactly as a substitution is — and the command arrives holding neither.
    ("REFUSED", "echo main | xargs git push origin"),
    ("REFUSED", "git branch --show-current | xargs -I{} git push origin {}"),
    # A shell handed its commands on its own input. Piped in, what it will run is
    # not settled until the left-hand side runs, so nothing here can read it; in a
    # here-document body it is right there and is read.
    ("REFUSED", "echo 'git push origin main' | bash"),
    ("REFUSED", "bash <<'EOF'\ngit push origin main\nEOF"),
    ("REFUSED", "sh <<'EOF'\ngit push origin main\nEOF"),
    ("ALLOWED", "bash <<'EOF'\ngit status\nEOF"),
    # A subshell has a directory of its own, and `{loose}` is a checkout that
    # lands its own work. Carried across the brackets, the push after them is
    # judged by that checkout's permission while the shell runs it in this one.
    ("REFUSED", "(cd {loose}) && git push origin main"),
    ("ALLOWED", "(cd {loose} && git push origin main)"),
    # A command written behind one of the shell's own words is still that command.
    ("REFUSED", "if true; then git push origin main; fi"),
    ("REFUSED", "for b in main; do git push origin $b; done"),
    ("REFUSED", "while true; do git push origin main; done"),
    # A line that abandons a fold and then writes to a shipping line is two
    # commands, and the first one's switch does not excuse the second.
    ("REFUSED", "git merge --abort && git push origin main"),
    # The same routes with the line named in quotes. A guard that reads its
    # targets off text with the quoted stretches taken out sees no target here.
    ("REFUSED", 'git push origin "main"'),
    ("REFUSED", 'git checkout "staging" && git merge feature/mine'),
    # A card's own words about a fold are words. A bracket in prose reads as a
    # command separator, which is how a note describing these once refused itself.
    # The quoted route is one that would be refused if it were read as a command,
    # or the case would pass whether the words are read as words or not.
    ("ALLOWED",
     'bd close x --reason="the fold (git checkout staging && git merge feature)'
     ' is refused"'),
)

# The same question asked while standing on a shipping line, where a command that
# names no line at all writes to one. Nothing in the table above stands there, so
# nothing above exercises the rule that an ordinary commit is a route.
ON_MAIN = (
    ("REFUSED", "git commit -m fix"),
    ("REFUSED", "git -c user.email=t@t commit -m fix"),
    ("REFUSED", "git -C . push origin main"),
    ("REFUSED", "git push"),
    ("REFUSED", "git push origin HEAD"),
    ("REFUSED", "git cherry-pick abc1234"),
    ("REFUSED", "git reset --hard origin/main"),
    ("REFUSED", "git reset --soft HEAD~1"),
    ("ALLOWED", "git reset"),
    # Naming the position you stand at moves the line nowhere: this throws the
    # agent's own uncommitted work away and writes to nothing. The same rule the
    # refspecs already read HEAD by.
    ("ALLOWED", "git reset --hard HEAD"),
    ("ALLOWED", "git reset --hard @"),
    # `git commit -m --abort` commits, with the message `--abort`. Read as a
    # mid-fold switch it stands the command down, on the very line the job was
    # opened about.
    ("REFUSED", "git commit -m --abort"),
    ("REFUSED", "git commit --message --continue"),
    # And making a line of your own with the long spelling is making a line of
    # your own: the commit behind it belongs there, not to the line left behind.
    ("ALLOWED", "git switch --create feature/next && git commit -m fix"),
    # A commit written behind one of the shell's own words is a commit, and here
    # it lands on the line the project ships from.
    ("REFUSED", "if ! git diff --quiet; then git commit -m x; fi"),
    ("REFUSED", "for f in a b; do git commit -m x; done"),
    # And a commit after brackets that changed directory inside them lands on the
    # line being stood on HERE, which is the one the project ships from.
    ("REFUSED", "(cd {loose}) && git commit -m fix"),
    # Naming a commit and a file takes the file out of what is staged and moves
    # no line at all, which is what the second name is there to say.
    ("ALLOWED", "git reset HEAD file.txt"),
    # Bringing the same line down from the remote is staying current and sends
    # nothing of the agent's anywhere; bringing a different one down folds that
    # work into the line being stood on, which is landing it by another word.
    ("ALLOWED", "git pull"),
    ("ALLOWED", "git pull --ff-only"),
    ("ALLOWED", "git pull --rebase origin main"),
    ("REFUSED", "git pull origin feature/mine"),
    # And the same question of a fetch, from the line itself.
    ("ALLOWED", "git fetch origin main:main"),
    ("REFUSED", "git fetch origin feature/mine:main"),
    # A line the shell works out as it runs is a line nothing here can read.
    ("REFUSED", "git push origin $(git branch --show-current)"),
    ("REFUSED", "git push origin `git branch --show-current`"),
    # Renaming away the line you stand on destroys it.
    ("REFUSED", "git branch -M scratch"),
    ("REFUSED", 'sh -c "git commit -m x"'),
    ("ALLOWED", "git add -A"),
    ("ALLOWED", "git checkout -b feature/next"),
    ("ALLOWED", "git checkout -b feature/next && git commit -m fix"),
)

# A command aimed at a second checkout, which `{other}` names. The permission that
# answers for it is that checkout's own, whatever the session's own project says,
# and changing into it must answer exactly as naming it with a switch does.
ELSEWHERE = (
    ("REFUSED", "git -C {other} push origin main"),
    ("REFUSED", "git -C {other} commit -m fix"),
    ("REFUSED", "cd {other} && git push origin main"),
    ("REFUSED", "cd {other} && git commit -m fix"),
    # Every spelling of changing directory reaches the same checkout, including
    # the two that keep a stack and the one that separates the path.
    ("REFUSED", "pushd {other} && git push origin main"),
    ("REFUSED", "cd -- {other} && git push origin main"),
    ("REFUSED", "pushd {other} && git commit -m fix"),
    # The shortcut for a home directory is how a path is actually typed. Joined
    # before it is expanded it names nowhere, and a walk up from nowhere comes
    # back to the session's own project.
    ("REFUSED", "git -C {tilde} push origin main"),
    ("REFUSED", "cd {tilde} && git commit -m fix"),
    # A checkout is also named by its working tree and by its git directory, in a
    # switch or in a setting put in front of the command.
    ("REFUSED", "git --git-dir={other}/.git --work-tree={other} push origin main"),
    ("REFUSED", "git --git-dir={other}/.git push origin main"),
    ("REFUSED", "GIT_DIR={other}/.git git push origin main"),
    # A setting made on a command of its own stands for the commands after it.
    ("REFUSED", "export GIT_DIR={other}/.git && git push origin main"),
    ("REFUSED", "export GIT_WORK_TREE={other} && git commit -m fix"),
    ("REFUSED", "GIT_WORK_TREE={other}\ngit commit -m fix"),
    ("REFUSED", "GIT_WORK_TREE={other} git commit -m fix"),
)

# A forge command names the repository it acts on, and that repository may not be
# this one. The permission belongs to what is being written to — which is the
# whole of what this change moved for every git route.
FORGE = (
    ("REFUSED", "gh pr merge --repo other/thing 412 --squash"),
    ("REFUSED", "gh pr merge -R other/thing 412"),
    ("REFUSED", "gh api --method PUT repos/other/thing/pulls/412/merge"),
    ("ALLOWED", "gh pr merge --repo scratch/own 412 --squash"),
    ("ALLOWED", "gh api --method PUT repos/scratch/own/pulls/412/merge"),
    ("ALLOWED", "gh pr merge 412 --squash"),
    # The query endpoint carries the instruction as a field and names no
    # repository at all — so it names one this checkout is not, whatever this
    # checkout is. Asking it a question still costs nothing.
    ("REFUSED", "gh api graphql -f query=mutation{mergePullRequest(input:{a:b}){c}}"),
    ("ALLOWED", "gh api graphql -f query=query{repository(name:x){id}}"),
)

# Somebody else's repository, checked out INSIDE a project whose agents land
# their own work — a vendored dependency, a submodule, a nested clone. The
# declaration is found by walking up, so without a check it is answered for by
# the project around it and every one of its lines is open. `{other}` sits BESIDE
# the project, so nothing in that table reaches this.
NESTED = (
    ("REFUSED", "git -C {inner} push origin main"),
    ("REFUSED", "git -C {inner} commit -m fix"),
    ("REFUSED", "cd {inner} && git push origin main"),
    ("ALLOWED", "git -C {inner} push origin feature/mine"),
)

# A shipping line that so far exists only on the remote, which is how it looks in
# a fresh clone. Stepping onto it makes a local one and lands there; a name that
# is only checked against local lines is not seen as a step at all, and the write
# behind it is credited to the line left behind.
REMOTE_ONLY = (
    ("REFUSED", "git checkout staging && git commit -m x"),
    ("REFUSED", "git switch staging && git commit -m x"),
    # And named by the remote it is tracked on, which lands on the line it tracks.
    ("REFUSED", "git checkout --track origin/staging && git commit -m x"),
    ("REFUSED", "git checkout origin/staging && git commit -m x"),
    ("ALLOWED", "git checkout -b feature/next && git commit -m x"),
)

# A team whose agents land on a line of their own, and whose manager alone moves
# that into what ships. Naming what is protected has to be taken at its word.
TEAM = (
    ("ALLOWED", "git checkout staging && git merge feature/mine"),
    ("ALLOWED", "git push origin staging"),
    ("REFUSED", "git push origin main"),
)


def scratch_project(tmp, says=None, on="feature/mine", remote=()):
    """A checkout with a main and a staging line, standing on `on`, declaring
    `says` — or nothing, for a project nobody has ever thought about.

    `remote` names lines that are left existing ONLY as remote-tracking ones,
    which is what a shipping line looks like in a fresh clone before anybody has
    stepped onto it."""
    for args in (["init", "-q", "-b", "main", "."],
                 ["remote", "add", "origin", "https://github.com/scratch/own.git"],
                 ["-c", "user.email=t@t", "-c", "user.name=t",
                  "commit", "-q", "--allow-empty", "-m", "base"],
                 ["branch", "staging"], ["checkout", "-q", "-B", on]):
        subprocess.run(["git"] + args, cwd=tmp, capture_output=True, timeout=60)
    for name in remote:
        for args in (["update-ref", "refs/remotes/origin/" + name, "HEAD"],
                     ["branch", "-D", name]):
            subprocess.run(["git"] + args, cwd=tmp, capture_output=True, timeout=60)
    # Somewhere further in, so a command that moves deeper into the same checkout
    # has somewhere real to move to.
    os.makedirs(os.path.join(tmp, "sub"), exist_ok=True)
    if says is not None:
        with open(os.path.join(tmp, project.DECLARATION), "w") as fh:
            fh.write(says)


if "--door" in sys.argv:
    # One throwaway checkout and nothing else, so a run can be started the way a
    # commit hook starts one and the answer read from outside: `own` if it built
    # its own repository, and otherwise whatever it did to somebody else's. This
    # is the whole of what the clearing at the top of the file is for, and the
    # only way to prove it is from a process that was started pointed elsewhere.
    _door = tempfile.mkdtemp(prefix="board-door-")
    try:
        scratch_project(_door)
        print("own" if os.path.isdir(os.path.join(_door, ".git")) else "elsewhere")
    finally:
        shutil.rmtree(_door, ignore_errors=True)
    sys.exit(0)


# A session record older than the board's five-minute claim lease, by enough that
# no clock skew reads it as still at work.
LONG_GONE = 3600
LANDER = "aaaabbbb-cccc-dddd-eeee-ffff00001111"
LIVE_SID = "11112222-3333-4444-5555-666677778888"
DEAD_SID = "deadbeef-0000-1111-2222-333344445555"
# A board that answers the two questions the landing gate asks it: who holds the
# merge slot, and what every card held right now is held by. The slot is always
# the session doing the landing, because these cases are about what is in the
# checkout rather than about the queue.
BOARD = '''#!/usr/bin/env sh
case "$*" in
  *"merge-slot"*) echo '{"holder": "main-%s"}' ;;
  *) echo '%%s' ;;
esac
''' % LANDER[:8]


def merge_says(cmd, says=None, on="feature/mine", board=False):
    """What the merge guard tells one command, in words — for the cases that turn
    on what a refusal has to teach rather than on whether it refuses."""
    tmp = tempfile.mkdtemp(prefix="board-merge-")
    try:
        scratch_project(tmp, says, on)
        if board:
            os.makedirs(os.path.join(tmp, ".beads"), exist_ok=True)
        out = subprocess.run(
            [sys.executable, MERGE_GATE], input=json.dumps({
                "tool_name": "Bash", "tool_input": {"command": cmd},
                "cwd": tmp, "session_id": "selftest-merge"}),
            capture_output=True, text=True, timeout=120).stdout.strip()
        if not out:
            return ""
        return json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def merge_routes(says=None, on="feature/mine", rows=ROUTES, remote=()):
    """What the merge guard tells each route, run from a scratch project standing
    on `on` and declaring `says` — or nothing, for a project nobody has declared.

    A project of its own on disk: the guard reads a declaration and the line being
    stood on off the checkout it is handed, so neither can be faked in memory. The
    second checkout `{other}` names is undeclared and sits outside the first, so a
    walk up from it can never reach the first one's declaration.
    """
    tmp = tempfile.mkdtemp(prefix="board-merge-")
    other = tempfile.mkdtemp(prefix="board-other-")
    # A third checkout that lands its own work, so a command judged against the
    # wrong one of the two comes out ALLOWED and the case can see it.
    loose = tempfile.mkdtemp(prefix="board-loose-")
    try:
        scratch_project(tmp, says, on, remote)
        scratch_project(other, None, "main")
        scratch_project(loose, 'name = "loose"\nagent_merges = true\n', "main")
        # Somebody else's repository sitting inside the first one, which is what a
        # vendored dependency or a submodule is. Built always: it costs one `git
        # init` and it is the only way to reach the walk up from a nested checkout.
        inner = os.path.join(tmp, "vendor", "dep")
        os.makedirs(inner, exist_ok=True)
        scratch_project(inner, None, "main")
        got = {}
        for _, cmd in rows:
            said = cmd.replace("{other}", other).replace("{inner}", inner) \
                      .replace("{loose}", loose) \
                      .replace("{tilde}", "~/" + os.path.basename(other))
            env = dict(os.environ)
            if "{tilde}" in cmd:
                # So the shortcut resolves to the second checkout and nowhere else.
                env["HOME"] = os.path.dirname(other)
            out = subprocess.run(
                [sys.executable, MERGE_GATE], input=json.dumps({
                    "tool_name": "Bash", "tool_input": {"command": said},
                    "cwd": tmp, "session_id": "selftest-merge"}),
                capture_output=True, text=True, timeout=120, env=env).stdout.strip()
            got[cmd] = "REFUSED" if out else "ALLOWED"
        return got
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(other, ignore_errors=True)
        shutil.rmtree(loose, ignore_errors=True)


def waiving(sid, age=0):
    """What the stop gate says to a turn it would otherwise send back to work,
    run under a waiver `age` seconds old written against session `sid`.

    The gate is always judging session `selftest`, so `sid` is what decides
    whether the waiver is this session's or another's. A state directory of its
    own: the real one is read by every live session on this machine.
    """
    tmp = tempfile.mkdtemp(prefix="board-waiver-")
    was, gate.bc.STATE_DIR = gate.bc.STATE_DIR, tmp
    try:
        with open(gate.bc.waiver_path(sid), "w") as fh:
            json.dump({"words": "no beads required for this",
                       "t": T + 50 - age, "session": sid}, fh)
        return carrying_on(["c"])[0]
    finally:
        gate.bc.STATE_DIR = was
        shutil.rmtree(tmp, ignore_errors=True)


def carrying_on(held, closed=(), goals=(), asked=False, helper=False, pushes=0,
                again=False):
    """What the stop gate says to a turn ending with `held` still claimed.

    `goals` is what the board answers about the cards closed in the turn: each is
    the card, the goal above it, and that goal's status. Nothing here touches a
    board — `bd` answers out of that list and nothing else.
    """
    state = {"edits": [], "created": [], "claims": [], "last_stop": T,
             "closed": [{"id": c, "t": T + 40} for c in closed],
             "asked": T + 45 if asked else 0,
             "helper": T + 45 if helper else 0, "pushes": pushes}
    kept = {}
    rows = {c: {"id": c, "labels": ["of:" + g]} for c, g, _ in goals}
    rows.update({g: {"id": g, "status": s} for _, g, s in goals})
    gate.bc.load = lambda sid: dict(state)
    gate.bc.save = lambda sid, s: kept.update(s)
    gate.bc.now = lambda: T + 50
    gate.bc.held = lambda name, root=None: list(held)
    gate.bc.machine_name = lambda root=None: "someone"
    gate.bc.reviewing = lambda: ""
    gate.bc.actor = lambda sid, cwd: "test-session"
    gate.bc.bd = lambda args, root=None: (
        True, json.dumps([rows[a] for a in args if a in rows]))
    sys.stdin = io.StringIO(json.dumps({
        "session_id": "selftest", "cwd": ROOT, "stop_hook_active": again,
        "last_assistant_message": "done http://127.0.0.1:3008/api/reports/page?x=1",
    }))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        gate.main()
    finally:
        sys.stdout = keep
    printed = out.getvalue().strip()
    # Everything the gate wrote back, for a case that has to read more of it than
    # the push count — what a turn leaves behind is as much the gate's answer as
    # what it says.
    carrying_on.kept = kept
    return (json.loads(printed)["reason"] if printed else ""), kept.get("pushes")


# The reply a turn ends on, and the cards it poured while writing it. A fault named
# in words has two homes and no third (docs/board.md#two-ways), so a card of either
# shape satisfies the gate and neither being there is the refusal.
PUT_DOWN = ("There is also a flicker in the tree shadows. I noticed it while fixing "
            "the fog. Leaving that for now and will get to it later.")


def reporting(said, made=()):
    """What the stop gate says to a turn ending on `said`, having poured `made`."""
    state = {"edits": EDITS, "last_stop": T, "closed": [], "asked": T + 45,
             "claims": [{"id": "c", "t": T + 5}],
             "created": [{"id": cid, "t": T + 40} for cid in made]}
    gate.bc.load = lambda sid: dict(state)
    gate.bc.save = lambda sid, s: None
    gate.bc.now = lambda: T + 50
    gate.bc.held = lambda name, root=None: ["c"]
    gate.bc.machine_name = lambda root=None: "someone"
    gate.bc.reviewing = lambda: ""
    gate.bc.actor = lambda sid, cwd: "test-session"
    gate.bc.bd = lambda args, root=None: (True, "[]")
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": ROOT, "last_assistant_message": said}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        gate.main()
    finally:
        sys.stdout = keep
    printed = out.getvalue().strip()
    return json.loads(printed)["reason"] if printed else ""


# The manager's own words, the day this gate was asked for. Every phrase the brief
# for it listed — always, keeps, every time, again, still — is absent from them, so
# a screen built from that list alone reads his complaint as ordinary prose.
HIS_COMPLAINT = ("whenever I point a systematic issue to Claude it starts fixing the "
                 "examples, when it should be finding a way to make sure this doesn't "
                 "happen in the future")
NAMED = "fixes the examples instead of what produced them"


def pointed_at(verdict, made=(), prompt="habit-case"):
    """What the stop gate says to a turn whose message was read like this, and what
    it counted.

    `verdict` is put on disk in the shape the reading leaves it and read back by the
    gate's own reader, so the shapes that are not an answer at all — nothing written,
    a torn write, JSON that is not an object — go through the same path a real one
    does. `None` writes nothing.
    """
    state = {"edits": [], "last_stop": T, "closed": [], "asked": T + 45,
             "claims": [{"id": "c", "t": T + 5}],
             "created": [{"id": cid, "t": T + 40} for cid in made]}
    gate.bc.load = lambda sid: dict(state)
    gate.bc.save = lambda sid, s: None
    gate.bc.now = lambda: T + 50
    gate.bc.held = lambda name, root=None: ["c"]
    gate.bc.machine_name = lambda root=None: "someone"
    gate.bc.reviewing = lambda: ""
    gate.bc.actor = lambda sid, cwd: "test-session"
    gate.bc.bd = lambda args, root=None: (True, "[]")
    os.makedirs(gate.bc.HABIT_DIR, exist_ok=True)
    where = gate.bc.habit_path(prompt)
    if verdict is None:
        if os.path.exists(where):
            os.remove(where)
    elif isinstance(verdict, str):
        open(where, "w").write(verdict)
    else:
        gate.bc.habit_write(prompt, verdict)
    fired, was = [], gate.tally
    gate.tally = fired.append
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": ROOT, "prompt_id": prompt,
         "last_assistant_message": "I have rewritten the three files you named."}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        gate.main()
    finally:
        sys.stdout, gate.tally = keep, was
    printed = out.getvalue().strip()
    return (json.loads(printed)["reason"] if printed else ""), fired


def reading_on(said, prompt="reading-case"):
    """What the reading hook does with one message: what it leaves on disk, what it
    spends, and what it puts into the session — which has to be nothing at all."""
    fired, spawned = [], []
    was_tally, reading.tally = reading.tally, lambda n, v=1: fired.append(n)
    was_spawn = reading.subprocess.Popen
    reading.subprocess.Popen = lambda *a, **k: spawned.append(a[0])
    reading.bc.reviewing = lambda: ""
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": ROOT, "prompt_id": prompt, "prompt": said}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    try:
        reading.main()
    finally:
        sys.stdout = keep
        reading.tally, reading.subprocess.Popen = was_tally, was_spawn
    return reading.bc.habit_read(prompt), fired, spawned, out.getvalue()


def suite_with_switch(by_file):
    """This suite again, run with the habit gate switched off — by the file when
    `by_file`, by the variable otherwise. Returns (exit code, the tail of what it said).

    A state directory of its own either way: that route's switch is a file inside
    one, and the real directory is read by every live session on this machine.
    """
    tmp = tempfile.mkdtemp(prefix="board-switch-")
    env = dict(os.environ, CLAUDE_CODE_TMPDIR=tmp)
    env.pop(gate.bc.HABIT_OFF_VAR, None)
    if by_file:
        state = os.path.join(tmp, "board-sessions")
        os.makedirs(state)
        open(os.path.join(state, os.path.basename(gate.bc.HABIT_OFF_FILE)), "w").close()
    else:
        env[gate.bc.HABIT_OFF_VAR] = "1"
    try:
        ran = subprocess.run([sys.executable, os.path.realpath(__file__), CHILD],
                             capture_output=True, text=True, env=env, timeout=600)
        return ran.returncode, (ran.stdout + ran.stderr).strip()[-600:]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# A repo of its own, so the case can leave a file dirty and land another under a
# card without touching this one. The step was claimed in 2010: the history the
# repo starts with is older, and every commit made under a card is newer.
BEGAN = datetime.datetime(2010, 1, 1, tzinfo=datetime.timezone.utc).timestamp()
STEP = "tst-x.9"


def scratch_repo(tmp, unmerged=False):
    """A repo holding one file per case, and a worktree cut from it.

    `unmerged` leaves a commit on the worktree's own branch that never reached
    main — what a job looks like mid-flight, and nothing for a case about an
    empty copy.
    """
    def g(*args, cwd=tmp, when=None):
        env = dict(os.environ)
        if when:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = when
        subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True,
                       env=env)

    g("init", "-b", "main")
    g("config", "user.email", "selftest@example.com")
    g("config", "user.name", "selftest")
    for name in TRACKED:
        open(os.path.join(tmp, name), "w").write("first\n")
    g("add", "-A")
    # Before the step was ever claimed, so what it already held is not this
    # step's doing — the same as any file a job's history already carries.
    g("commit", "-m", "the files this case starts from", when="2000-01-01T00:00:00Z")
    for name, message in (
            ("landed-here", "work(x): %s written under the step's own card" % STEP),
            ("landed-elsewhere", "work(x): tst-x.4 under a work item of this job"),
            ("landed-lookalike", "work(x): tst-x.91 under an item whose id starts the same"),
            ("landed-other-job", "work(y): tst-y.2 under a card of some other job"),
            ("landed-under-both", "work(x): tst-x.4 under a work item of this job")):
        open(os.path.join(tmp, name), "w").write("changed\n")
        g("add", "-A")
        g("commit", "-m", message)
    # The step's own commit, hidden behind a sibling's on the same file: a job's
    # steps edit the same handful of files, so this is the ordinary case.
    open(os.path.join(tmp, "landed-under-both"), "w").write("changed again\n")
    g("add", "-A")
    g("commit", "-m", "work(x): %s the step's own hand on the same file" % STEP)
    open(os.path.join(tmp, "left-dirty"), "w").write("changed\n")
    second = os.path.join(tmp, "worktrees", "second")
    g("worktree", "add", second, "-b", "second")
    # Written and committed on the job's own branch, which is not the same as
    # being in the game: the merge has not happened.
    if unmerged:
        open(os.path.join(second, "committed-not-merged"), "w").write("changed\n")
        g("add", "-A", cwd=second)
        g("commit", "-m", "work(x): tst-x.4 written but not merged yet", cwd=second)

    # A repository checked out inside this one. Its files belong to no index
    # entry of the tree around it, so the outer repository answers nothing.
    inner = os.path.join(tmp, "inner-origin")
    os.makedirs(inner)
    open(os.path.join(inner, "vendored"), "w").write("first\n")
    for args in (("init", "-b", "main"), ("config", "user.email", "selftest@example.com"),
                 ("config", "user.name", "selftest"), ("add", "-A"),
                 ("commit", "-m", "the vendored file")):
        g(*args, cwd=inner)
    g("-c", "protocol.file.allow=always", "submodule", "add", "./inner-origin", "vendor")
    g("commit", "-m", "the vendored repository, pinned")
    open(os.path.join(tmp, "vendor", "vendored"), "w").write("changed\n")
    open(os.path.join(second, "worktree-dirty"), "w").write("written in the worktree\n")
    return second


# A job at its teardown, whose one copy of the work is the scratch repo's own.
# `assignee` is what says which copy the job worked in: a board name opens with
# the tree it was claimed from (board_common.actor).
TEARDOWN = {"id": "tst-x.9", "status": "in_progress", "issue_type": "task",
            "started_at": "2020-01-01T00:00:00Z",
            "labels": ["step:land", "of:tst-x", "no-code", "area:board",
                       "kind:feature"],
            "notes": "Teardown: the merge slot is released and the job is finished."}


def teardown(tmp, answers=True, closed_only=True):
    """What the gate says to `bd close tst-x.9` with the scratch copy on disk.

    `closed_only` is the shape a real board has at this moment: every step the
    session claimed inside the copy is already closed, so a query that does not
    ask for closed cards gets back nothing that names the copy. `answers=False`
    is a board that could not answer at all.
    """
    def recorder(args, root=None):
        if args[0] == "show":
            return True, json.dumps(TEARDOWN if args[1] == "tst-x.9"
                                    else {"id": "tst-x", "issue_type": "epic",
                                          "labels": ["job"], "metadata": {},
                                          "notes": "a page: http://x/y"})
        if args[0] == "list":
            if not answers:
                return False, ""
            if closed_only and "all" not in args:
                return True, "[]"
            return True, json.dumps([{"id": "tst-x.1", "assignee": "second-selftest"}])
        return True, "[]"

    status.bc.bd = recorder
    status.bc.reviewing = lambda: ""
    status.unfinished_spine = lambda card, root, me=None: []
    status.slot_holder = lambda root: ""
    status.page_stale = lambda cid, card, session, root: False
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": tmp,
         "tool_input": {"command": 'bd close tst-x.9 --reason="done"'}}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    # The gate prefers the environment's project directory over the command's own
    # cwd, so a case about a scratch repo would otherwise be judged against this one.
    here = os.environ.pop("CLAUDE_PROJECT_DIR", None)
    try:
        status.main()
    finally:
        sys.stdout = keep
        if here is not None:
            os.environ["CLAUDE_PROJECT_DIR"] = here
    said = out.getvalue().strip()
    return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"] \
        if said else ""


REAL_SPINE = status.unfinished_spine


def next_job(tmp, work_left, order="worktree,work,land", half=False):
    """What the gate says to a session claiming a new job's first step, while it
    still owns the scratch copy — whose own job either has work left, or does not.

    `order` empty is a goal poured before an order was ever recorded: nothing can
    be concluded about it, and concluding 'finished' refuses its owner the next
    job for no reason at all.
    """
    goal = {"id": "tst-old", "issue_type": "epic", "labels": ["job"],
            "metadata": {"spine": order} if order else {}}
    parented = [{"id": "tst-old.1", "status": "closed", "labels": ["step:worktree"]}]
    if not work_left:
        parented.append({"id": "tst-old.2", "status": "closed", "labels": ["step:work"]})
    elif half:
        # A step holds many cards at once, and a reader's objections arrive under
        # one whose earlier cards are all closed: the first to close must not
        # speak for the rest (cor-bqca.5).
        parented += [{"id": "tst-old.2", "status": "closed", "labels": ["step:work"]},
                     {"id": "tst-old.3", "status": "open", "labels": ["step:work"]}]

    def recorder(args, root=None):
        if args[0] == "show":
            return True, json.dumps(goal if args[1] == "tst-old" else
                                    {"id": args[1], "issue_type": "task",
                                     "labels": ["step:worktree", "of:tst-new"]})
        if args[:2] == ["list", "--parent"]:
            # Only the old job has pieces; the card being claimed is a step, and
            # answering for it too would make it read as a container.
            return True, json.dumps(parented if args[2] == "tst-old" else [])
        if args[0] == "list" and "--assignee" in args:
            held = args[args.index("--assignee") + 1]
            return True, json.dumps(
                [{"id": "tst-old.1", "labels": ["of:tst-old"]}]
                if held == "second-selftest" else [])
        return True, "[]"

    status.bc.bd = recorder
    status.bc.reviewing = lambda: ""
    # An earlier case stubs this out; here it is the thing under test.
    status.unfinished_spine = REAL_SPINE
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": tmp,
         "tool_input": {"command": "bd update tst-new.1 --claim"}}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    here = os.environ.pop("CLAUDE_PROJECT_DIR", None)
    try:
        status.main()
    finally:
        sys.stdout = keep
        if here is not None:
            os.environ["CLAUDE_PROJECT_DIR"] = here
    said = out.getvalue().strip()
    return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"] \
        if said else ""


READING = runner.GATE_TITLE


def excused(deps, cid="tst-j.1", answers=True):
    """Whether this card is waiting only on the reading of a job it belongs to.

    `deps` is the board's answer to "what is in the way", keyed by card; `answers`
    off is a board that did not reply. Nothing here touches a board.
    """
    def board(args, root=None):
        if not answers:
            return False, ""
        return True, json.dumps(deps.get(args[2], []) if args[0] == "dep" else [])

    was = status.bc.bd
    status.bc.bd = board
    try:
        return status.waits_only_on_its_own_reading(cid, ROOT)
    finally:
        status.bc.bd = was


def claim_of(tmp, deps):
    """What the gate says to a claim on a card the board reports as waiting.

    Drives the hook rather than the judgement underneath it, so removing the
    judgement from the refusal is caught too.
    """
    def board(args, root=None):
        if args[0] == "blocked":
            return True, json.dumps([{"id": "tst-j.1"}])
        if args[0] == "dep":
            return True, json.dumps(deps.get(args[2], []))
        if args[0] == "show":
            return True, json.dumps({"id": args[1], "issue_type": "task",
                                     "labels": ["step:work", "of:tst-j"]})
        return True, "[]"

    status.bc.bd = board
    status.bc.reviewing = lambda: ""
    sys.stdin = io.StringIO(json.dumps(
        {"session_id": "selftest", "cwd": tmp,
         "tool_input": {"command": "bd update tst-j.1 --claim"}}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    here = os.environ.pop("CLAUDE_PROJECT_DIR", None)
    try:
        status.main()
    finally:
        sys.stdout = keep
        if here is not None:
            os.environ["CLAUDE_PROJECT_DIR"] = here
    said = out.getvalue().strip()
    return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"] \
        if said else ""


def census(tmp, busy):
    """What `scripts/board/copies` says about the scratch repo's own copies.

    Loaded against `tmp` rather than this project, and handed the set of copies
    somebody is working in, so the case is about the judgement rather than about
    whose sessions happen to be alive — which is the whole point of it
    (cor-futg.16).
    """
    os.environ["MACHINERY_COPIES_ROOT"] = tmp
    try:
        spec = importlib.util.spec_from_loader(
            "copies", importlib.machinery.SourceFileLoader(
                "copies", os.path.join(HOME, "board", "copies")))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        os.environ.pop("MACHINERY_COPIES_ROOT", None)
    out, err = io.StringIO(), io.StringIO()
    keep_out, keep_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        code = mod.main(busy=busy)
    finally:
        sys.stdout, sys.stderr = keep_out, keep_err
    return code, out.getvalue() + err.getvalue()


def flags_are_real(tmp):
    """Whether bd itself accepts the query the two refusals depend on.

    Every other case here replaces bd with a recorder that answers anything, so
    a flag bd does not support would pass the whole suite and switch the rule
    off in production (cor-futg.15). This one asks the real bd — on a board of
    its own, created here and thrown away, never this project's.
    """
    board = os.path.join(tmp, "throwaway")
    os.makedirs(board)
    if subprocess.run(["bd", "init", "--prefix", "tst"], cwd=board,
                      capture_output=True, text=True).returncode != 0:
        return None
    run = subprocess.run(
        ["bd", "list", "--json", "--limit", "0", "--status", "all",
         "--label", "of:tst-1"], cwd=board, capture_output=True, text=True)
    if run.returncode != 0:
        return run.stderr.strip() or "bd refused the query"
    try:
        json.loads(run.stdout or "[]")
    except Exception:
        return "bd answered something that is not a list of cards"
    return ""


def submodule_copy(tmp):
    """A copy carrying a submodule, which is what every copy of this project is.

    git refuses `worktree remove` for one of these outright, so the route the
    refusal prints has to be the other one (cor-futg).
    """
    def g(*args, cwd=tmp):
        return subprocess.run(["git", "-c", "protocol.file.allow=always"] + list(args),
                              cwd=cwd, capture_output=True, text=True)

    g("init", "-b", "main")
    g("config", "user.email", "selftest@example.com")
    g("config", "user.name", "selftest")
    open(os.path.join(tmp, "a-file"), "w").write("x\n")
    g("add", "-A")
    g("commit", "-m", "the one commit this copy is cut from")

    sub = os.path.join(tmp, "sub-origin")
    os.makedirs(sub)
    g("init", "-b", "main", cwd=sub)
    g("config", "user.email", "selftest@example.com", cwd=sub)
    g("config", "user.name", "selftest", cwd=sub)
    open(os.path.join(sub, "a"), "w").write("x\n")
    g("add", "-A", cwd=sub)
    g("commit", "-m", "the submodule's one commit", cwd=sub)
    g("submodule", "add", sub, "vendor/dep")
    g("commit", "-am", "vendor: the submodule this copy carries")
    tree = os.path.join(tmp, "worktrees", "withsub")
    g("worktree", "add", tree, "-b", "withsub")
    g("submodule", "update", "--init", "vendor/dep", cwd=tree)
    return tree


# One file per branch of the rule: written under the step itself, under a work
# item of the same job, under an item whose id merely starts with the step's,
# under another job's card, left dirty in each tree, and put back where it was.
TRACKED = ["landed-here", "landed-elsewhere", "landed-lookalike",
           "landed-other-job", "landed-under-both", "left-dirty", "put-back"]


def standing(root, edited_in, second):
    """Which files the gate says are still standing under the step, judged from
    `root` while the edits were made in `edited_in` and in the worktree."""
    edits = [{"p": os.path.join(edited_in, f), "t": BEGAN + 10} for f in TRACKED]
    edits.append({"p": os.path.join(second, "worktree-dirty"), "t": BEGAN + 10})
    edits.append({"p": os.path.join(second, "committed-not-merged"), "t": BEGAN + 10})
    edits.append({"p": os.path.join(edited_in, "vendor", "vendored"), "t": BEGAN + 10})
    status.bc.load = lambda sid: {"edits": edits}
    card = {"labels": ["of:tst-x"],
            "started_at": datetime.datetime.fromtimestamp(
                BEGAN, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    return sorted(os.path.basename(p)
                  for p in status.wrote_code(STEP, card, "selftest", root))


proof = hook("helper-proof")


def helper_return(said, did=(), where=None):
    """What the helper gate says to a helper that did `did` in that order and
    ended with `said`. Each step is a tool name, or a name and a command.

    Every stand-in is put back afterwards: `bc` is one module shared by every
    hook here, so one left in place is another case's board.
    """
    lines = []
    for step in did:
        name, cmd = step if isinstance(step, tuple) else (step, "")
        lines.append(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": name, "input": {"command": cmd}}]}}))
    lines.append(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": said}]}}))
    path = os.path.join(where, "agent-case.jsonl")
    with open(path, "w") as fh:
        fh.write("\n".join(lines))
    sys.stdin = io.StringIO(json.dumps(
        {"hook_event_name": "SubagentStop", "cwd": ROOT,
         "agent_transcript_path": path}))
    out = io.StringIO()
    keep, sys.stdout = sys.stdout, out
    was = (proof.bc.reviewing, proof.bc.board_root, proof.bc.prefix)
    proof.bc.reviewing = lambda: ""
    proof.bc.board_root = lambda cwd=None: ROOT
    proof.bc.prefix = lambda root=None: FIXTURE
    try:
        proof.main()
    finally:
        sys.stdout = keep
        proof.bc.reviewing, proof.bc.board_root, proof.bc.prefix = was
    said_back = out.getvalue().strip()
    return json.loads(said_back)["reason"] if said_back else ""


def main():
    first = run("in_progress")
    assert any(a.startswith("update g -s in_review") for a in first), \
        "a job with nothing left to build was not drawn in the reading column: %s" % first
    assert any(a.startswith("gate create --blocks g") for a in first), \
        "a job waiting to be read was not held shut: %s" % first
    assert "READ g" in first, "a job with nothing left to build got no reader: %s" % first

    # Whoever picks up a returned item moves the job to in_progress, so the job's
    # own status cannot be what says it is waiting to be read again.
    sent_back = run("open", notes=SIGNED % "a1c0ffee")
    assert "READ g" in sent_back, \
        "a job that answered its reader was not read again: %s" % sent_back

    read = run("in_progress", notes=SIGNED % "a1c0ffee b2deadbe")
    assert "READ g" not in read, \
        "a job already read, with nothing written since, was read again: %s" % read
    assert not any("in_review" in a for a in read), \
        "a job already read was put back in the reading column: %s" % read

    itself = run("in_progress", notes=SIGNED % "a1c0ffee b2deadbe",
                 wrote=("review-g",))
    assert "READ g" in itself, \
        "a job that signed itself was taken as read: %s" % itself

    building = run("in_progress", rows=ROWS[:2] + [
        dict(ROWS[2], status="open"), ROWS[3]])
    assert not any("in_review" in a for a in building), \
        "a job still being built was moved to the reading column: %s" % building
    assert "READ g" not in building, \
        "a reader was sent at a job nobody has finished building: %s" % building

    print("ok: a job is read when it has nothing left to build, again when it has "
          "been written to since, and not otherwise")

    # The whole shape of the ceiling, in the order a job meets it: read when the
    # work is done, read once more when the reader's own findings are answered,
    # and never a third time however much has landed since (bw-7e8, read three
    # times, each round objecting to code the round before had accepted).
    once = run("in_progress")
    twice = run("open", notes=SIGNED % "a1c0ffee")
    thrice = run("open", notes=TWICE,
                 shas=("a1c0ffee", "b2deadbe", "c3landedsince"))
    assert "READ g" in once and "READ g" in twice, \
        "a job was not read after its work or not after its findings: %s / %s" \
        % (once, twice)
    assert "READ g" not in thrice, \
        "a job already read twice was read a third time, which is the round that " \
        "objects to what the round before it accepted: %s" % thrice
    assert release_sends(signed=True, shas=["a1c0ffee", "b2deadbe", "c3landedsince"],
                         notes=TWICE) == 0, \
        "a reader that had just done the job's last reading sent a third at it"
    assert reading_lib.rounds({"notes": TWICE}) == reading_lib.ROUNDS, \
        "the rounds a job has had are not counted off the receipts it carries"

    assert LAST_ROUND not in told_round(""), \
        "the first reader was told nobody comes after it"
    assert LAST_ROUND in told_round(SIGNED % "a1c0ffee"), \
        "the last reader a job gets was not told it is the last, so it leaves its " \
        "point for a round that never comes"

    # Answering the last reading's findings is what would have brought the reader
    # back. Nobody comes, so nothing else on the board would move the run on and
    # the job would sit behind its own gate for good (mch-4cl by another route).
    on = run("open", notes=TWICE, shas=("a1c0ffee", "b2deadbe", "c3landedsince"),
             gates=READING_GATE)
    assert "READ g" not in on, \
        "the job was read a third time after all: %s" % on
    assert any(a.startswith("gate resolve g-gate") for a in on), \
        "a job whose last reading's findings are answered stayed shut behind that " \
        "reading's own gate, waiting for a reader that is not coming: %s" % on
    assert any(a.startswith("create") for a in on), \
        "the run never opened the step after the reading, so the job stops where " \
        "the reading was: %s" % on
    assert any("append-notes" in a and "readings a job gets" in a for a in on), \
        "the goal says nothing about why its last reading's points were answered " \
        "with no reading after them: %s" % on
    # The gate is the latch: down once, the note is written once.
    again = run("open", notes=TWICE, shas=("a1c0ffee", "b2deadbe", "c3landedsince"))
    assert not any("append-notes" in a and "readings a job gets" in a for a in again), \
        "the run wrote the same line onto the goal every time a card closed: %s" % again

    print("ok: a job is read once when its work is done and once when its findings "
          "are answered, never a third time however much landed since, no reader "
          "sends a third from inside itself, the last reader is told it is the "
          "last, and answering that last reading opens the step after it instead "
          "of leaving the job shut")

    code, said = pours_with("no-such-project")
    assert code != 0 and "does not declare" in said, \
        "the pour took a landing this project never declared, and a card may close " \
        "on a commit in a repository its work never goes to: %s" % said
    if DECL.lands_elsewhere:
        code, said = pours_with(DECL.lands_elsewhere[0])
        assert "does not declare" not in said and "--what is an instruction" in said, \
            "a landing this project does declare was turned away by the pour, or " \
            "the pour was refused for something other than the next thing wrong " \
            "with it: %s" % said
        assert code != 0, \
            "the case poured a real card onto the board rather than being refused " \
            "for the next thing wrong with it: %s" % said

    print("ok: the pour writes a job's landing itself and turns away a checkout "
          "this project never declared its work lands in")

    found, judged, labelled = reads_elsewhere()
    assert not labelled, \
        "the case wrote the landing label itself, so it proves nothing about a job " \
        "without one"
    assert len(found) == 1, \
        "a job whose change landed in a checkout this project declares it may land " \
        "in was read as having written nothing: %s" % found
    assert len(judged) == 1, \
        "widening what a reading searches also widened what a card may close " \
        "against, which is a landing rule and not a search: %s" % judged

    print("ok: a reading counts the commits of every checkout this project declares "
          "it may land in, label or no label, and closing is still judged against "
          "the ones the job itself declared")

    cardless = sorted(s for s in spine.ORDER if not makes_card(s))
    assert cardless == ["review", "work"], \
        "the run makes a card for exactly the wrong positions: %s" % cardless
    try:
        spine.card("review", "g", {}, 1)
        raise AssertionError("the catalogue still hands out a review card")
    except ValueError:
        pass

    print("ok: no position of the playbook but the work and the reading is cardless, "
          "and the catalogue refuses a review card outright")

    assert stopping([{"id": "c", "t": T + 5}], [{"id": "c", "t": T + 40}], []), \
        "a turn that held a card through every edit and closed it was refused"
    assert stopping([{"id": "c", "t": T + 5}], [], ["c"]), \
        "a turn that still holds its card was refused"
    assert not stopping([], [], []), \
        "a turn that never claimed anything was allowed to end"
    assert not stopping([{"id": "c", "t": T + 1}], [{"id": "c", "t": T + 5}], []), \
        "edits made after the card was closed were allowed to end the turn"

    print("ok: the stop gate judges each edit against the cards standing over it "
          "at that moment, and a turn under no card is still refused")

    sent_back, _ = carrying_on(["c"])
    assert "c" in sent_back and "4f-when-a-session-may-stop" in sent_back, \
        "a turn ending with its own work still open and nothing asked of the " \
        "manager was allowed to end: %s" % (sent_back or "ALLOWED")
    assert carrying_on([])[0] == "", \
        "a turn holding nothing was sent back to work"
    assert carrying_on(["c"], asked=True)[0] == "", \
        "a turn that put a question to the manager was sent back to work"
    assert carrying_on(["c"], helper=True)[0] == "", \
        "a turn waiting on a helper it sent off was sent back to work"

    # The gap a held set cannot see: between closing a step and claiming the next,
    # a session holds nothing while its job is still running.
    gap, _ = carrying_on([], closed=("c",), goals=[("c", "g", "in_progress")])
    assert "g" in gap, \
        "a turn that closed a piece of a running job and held nothing was allowed " \
        "to end: %s" % (gap or "ALLOWED")
    for waiting in ("in_review", "blocked", "deferred", "manager_review"):
        assert carrying_on([], closed=("c",), goals=[("c", "g", waiting)])[0] == "", \
            "a job waiting on somebody who is not this session (%s) was still " \
            "pushed back at it" % waiting

    for spent in range(gate.PUSH_LIMIT):
        said, now = carrying_on(["c"], pushes=spent, again=spent > 0)
        assert said and now == spent + 1, \
            "push %d was not spent: %r, count now %r" % (spent + 1, said, now)
    last, now = carrying_on(["c"], pushes=gate.PUSH_LIMIT, again=True)
    assert last == "" and now == 0, \
        "the gate did not stand aside at its own ceiling, so the harness would " \
        "override it: %r, count now %r" % (last, now)

    # The teeth: with the reading of what is unfinished taken out, every refusal
    # above goes quiet. A case that would pass either way guards nothing.
    was, gate.unfinished = gate.unfinished, lambda *a, **k: []
    try:
        assert carrying_on(["c"])[0] == "" and \
            carrying_on([], closed=("c",), goals=[("c", "g", "in_progress")])[0] == "", \
            "the refusal survives the check being removed, so it is not what is " \
            "refusing"
    finally:
        gate.unfinished = was

    print("ok: a turn ending with the job still running is sent back to work, a "
          "question or a running helper or a job waiting on someone else ends it, "
          "and the gate stands aside at its own ceiling rather than being overruled")

    # His waiver, and the two things that stop it being a way round the board:
    # it is the session's own or it is nobody's, and it does not outlive the piece
    # of work he gave it for.
    assert carrying_on(["c"])[0], "the case is proving nothing: this turn ends " \
        "on its own without a waiver"
    assert waiving("selftest") == "", \
        "the board refused a turn the manager had waived: %r" % waiving("selftest")
    assert waiving("another-session"), \
        "a waiver written against one session took the board off a different one"
    assert waiving("selftest", age=gate.bc.WAIVER_KEEP + 1), \
        "a waiver still stood after it had expired, so one he gave for a one-line " \
        "change would carry a whole session"

    # A waived turn is finished, not skipped. Left unfinished, its edits are still
    # this turn's the moment the waiver lifts, and the session is handed a bill for
    # work he had already excused.
    carrying_on(["c"])
    assert carrying_on.kept.get("last_stop") == T, \
        "the case is proving nothing: a refused turn already moves the mark"
    waiving("selftest")
    assert carrying_on.kept.get("last_stop") == T + 50, \
        "a waived turn left its mark where it was, so everything done under the " \
        "waiver comes back as unclaimed work as soon as it lifts"

    print("ok: the manager's waiver takes the board off the session he gave it "
          "to, off no other session and no later work, and closes the turn it "
          "excused rather than leaving it to be billed afterwards")

    # A project nobody has declared is protected, and what it is protected from is
    # writing to a line other people ship from — never the word merge, which is
    # also how an agent stays current with one.
    silent = merge_routes()
    wrong = ["%s: %s, wanted %s" % (cmd, silent[cmd], want)
             for want, cmd in ROUTES if silent[cmd] != want]
    assert not wrong, "the guard answered %d routes wrongly in a project that has " \
        "declared nothing:\n  %s" % (len(wrong), "\n  ".join(wrong))

    # And the teeth, which are the manager's opt-out itself: the same routes in a
    # project that says its agents land their own work are refused none of them,
    # so it is the protection doing the refusing and not the shape of the command.
    said = merge_routes('name = "scratch"\nagent_merges = true\n')
    shut = [cmd for want, cmd in ROUTES if want == "REFUSED"
            and said[cmd] == "REFUSED"]
    assert not shut, "a project declaring agent_merges = true was still refused " \
        "these, so the refusal is not the protection: %s" % ", ".join(shut)

    # Standing on a shipping line, where a command that names no line writes to
    # one. The job was opened about exactly this route and nothing above stands
    # where it happens.
    home = merge_routes(on="main", rows=ON_MAIN)
    wrong = ["%s: %s, wanted %s" % (cmd, home[cmd], want)
             for want, cmd in ON_MAIN if home[cmd] != want]
    assert not wrong, "standing on a line the project ships from, the guard " \
        "answered %d routes wrongly:\n  %s" % (len(wrong), "\n  ".join(wrong))
    opted = merge_routes('name = "scratch"\nagent_merges = true\n',
                         on="main", rows=ON_MAIN)
    shut = [cmd for want, cmd in ON_MAIN if want == "REFUSED"
            and opted[cmd] == "REFUSED"]
    assert not shut, "a project declaring agent_merges = true could not commit " \
        "on its own main line: %s" % ", ".join(shut)

    # Where a command is aimed decides whose rules answer for it. A session in a
    # project of the manager's own reaches into a checkout nobody has declared and
    # is refused there, because the permission belongs to what is being written to
    # and never to the checkout the session was started in.
    reached = merge_routes('name = "scratch"\nagent_merges = true\n', rows=ELSEWHERE)
    through = [cmd for want, cmd in ELSEWHERE if reached[cmd] != want]
    assert not through, "a session in a project that lands its own work was " \
        "allowed to write to an undeclared checkout's shipping line: %s" \
        % ", ".join(through)

    # A forge command is judged by the repository it names. A session in one of
    # the manager's own projects must not be able to land a waiting piece of work
    # in the company's, which is the one thing this whole job is about.
    forge = merge_routes('name = "scratch"\nagent_merges = true\n', rows=FORGE)
    elsewhere = ["%s: %s, wanted %s" % (cmd, forge[cmd], want)
                 for want, cmd in FORGE if forge[cmd] != want]
    assert not elsewhere, "a forge command was judged by the checkout the shell " \
        "stands in rather than the repository it names:\n  %s" % "\n  ".join(elsewhere)

    # Somebody else's repository checked out inside a project that lands its own
    # work. The declaration is found by walking up, so the enclosing project would
    # otherwise hand its permission to a repository that never asked for it — and
    # the manager's largest project vendors one.
    inside = merge_routes('name = "scratch"\nagent_merges = true\n', rows=NESTED)
    borrowed = ["%s: %s, wanted %s" % (cmd, inside[cmd], want)
                for want, cmd in NESTED if inside[cmd] != want]
    assert not borrowed, "a repository checked out inside a project that lands " \
        "its own work inherited that permission:\n  %s" % "\n  ".join(borrowed)

    # A shipping line that so far exists only on the remote — a fresh clone, which
    # is what the company checkout looks like on the day somebody makes it.
    fresh = merge_routes(rows=REMOTE_ONLY, remote=("staging",))
    missed = ["%s: %s, wanted %s" % (cmd, fresh[cmd], want)
              for want, cmd in REMOTE_ONLY if fresh[cmd] != want]
    assert not missed, "stepping onto a line that exists only on the remote was " \
        "not seen as a step, so the write behind it was credited to the line " \
        "left behind:\n  %s" % "\n  ".join(missed)

    # A team that lands its agents' work on a line of their own, and moves that
    # into what ships by hand. Adding `lands_on` back to whatever a project names
    # leaves it with no line its agents may reach, which is the same wedge.
    team = merge_routes('name = "scratch"\nlands_on = "staging"\n'
                        'protected = ["main"]\n', rows=TEAM)
    ignored = ["%s: %s, wanted %s" % (cmd, team[cmd], want)
               for want, cmd in TEAM if team[cmd] != want]
    assert not ignored, "a project that named the lines it protects was not " \
        "taken at its word:\n  %s" % "\n  ".join(ignored)

    # Sending up the line you are on, named by running something, is the ordinary
    # spelling of an allowed command. It has to be told what it cannot be read as
    # and what to type instead, not that it writes to every line there is.
    unread = merge_says("git push origin $(git branch --show-current)")
    assert "HEAD" in unread and "every line" not in unread, \
        "the ordinary way of sending up the line you are on was refused with a " \
        "message about every line at once and no spelling that works: %s" \
        % (unread or "allowed")

    # And the project that says nothing while running a board is protected on the
    # very line its own cards close against, so the refusal has to name the way
    # out or the project can never finish anything.
    wedged = merge_says("git checkout main && git merge --ff-only feature/mine",
                        board=True)
    assert "agent_merges = true" in wedged and "closes only once" in wedged, \
        "a checkout running a board and declaring nothing was refused the only " \
        "route its own board accepts, with no way out named: %s" % (wedged or "allowed")

    # And none of that touched the repository a commit hook would have pointed
    # this run at. The cases build throwaway checkouts; a hook exports GIT_DIR and
    # GIT_INDEX_FILE as absolute paths to the repository being committed to, and
    # every git command here inherits them — so the throwaway is never built and
    # its commits, branches and checkouts land on the real one instead.
    victim = tempfile.mkdtemp(prefix="board-victim-")
    try:
        scratch_project(victim, None, "main")
        lines = ["git", "branch", "--format=%(refname:short)"]
        before = subprocess.run(lines, cwd=victim, capture_output=True, text=True,
                                timeout=60).stdout.split()
        door = subprocess.run(
            [sys.executable, os.path.realpath(__file__), "--door"],
            capture_output=True, text=True, timeout=120,
            env=dict(os.environ, GIT_DIR=os.path.join(victim, ".git"),
                     GIT_INDEX_FILE=os.path.join(victim, ".git", "index")))
        after = subprocess.run(lines, cwd=victim, capture_output=True, text=True,
                               timeout=60).stdout.split()
        assert before == after, \
            "a run started the way a commit hook starts one built its throwaway " \
            "checkout in the repository being committed to: %s became %s" \
            % (before, after)
        assert door.stdout.strip() == "own", \
            "the throwaway checkout was never built at all, because the settings " \
            "sent every command somewhere else: %s" % (door.stdout + door.stderr)[:300]
    finally:
        shutil.rmtree(victim, ignore_errors=True)

    print("ok: a project nobody has declared refuses every route onto a line it "
          "ships from — including standing on one and committing, and including a "
          "second checkout reached from a project that lands its own work — allows "
          "every way of staying current, a project that says its agents land their "
          "own work is refused none of them, and a card's own words are words")

    refused = reporting(PUT_DOWN)
    assert refused, "a fault the reply named and put down ended the turn with " \
        "nothing recorded anywhere but the session"
    assert "job under" in refused and "job find" in refused, \
        "the refusal named only one of the two ways a fault is recorded: %s" % refused
    assert reporting(PUT_DOWN, made=["tst-x.7"]) == "", \
        "a turn that did record the fault was refused anyway: %s" \
        % reporting(PUT_DOWN, made=["tst-x.7"])

    # The net narrowed to what it caught before the two-way rule — the one phrasing
    # of 'separate'. The case above stays green under it only if it is proving
    # something other than the widening.
    was = gate.DISCOVERY
    gate.DISCOVERY = re.compile(r"\b(separate (issue|bug|ticket|card|change|fix))",
                                re.IGNORECASE)
    try:
        assert reporting(PUT_DOWN) == "", \
            "a fault put down in these words is caught by the old word list too, " \
            "so the case above proves nothing about what was added to it"
    finally:
        gate.DISCOVERY = was

    for said in ("Leaving that for now.",
                 "I will circle back to it once the bake lands.",
                 "Left as-is — the second one still writes the wrong channel.",
                 "That belongs on a later ticket.",
                 "It needs a follow-up card of its own.",
                 "Deferring it until the cook is rewritten.",
                 "This is a known issue in the loader.",
                 "I did not fix the second one.",
                 "Won't fix here.",
                 "Handling that later.",
                 "The flicker is a separate issue."):
        assert reporting(said), "a fault put down as %r ended the turn unrecorded" % said

    # The other half of a phrase list: every one of these is ordinary prose in a
    # renderer, and a gate that refuses them is a gate sessions learn to talk around.
    for said in ("The follow-up question from the reviewer was about units.",
                 "The deferred pass reads the depth buffer before the later pass "
                 "resolves it.",
                 "Right, let's get to it.",
                 "The camera comes back to the start of the lap.",
                 "The fix landed and the suite is green."):
        assert reporting(said) == "", \
            "an ordinary sentence was read as a fault left standing: %r" % said

    print("ok: a fault the reply names and puts down cannot end the turn unrecorded, "
          "the refusal offers both ways of recording it, either satisfies it, and "
          "ordinary prose about a deferred pass is left alone")

    tmp = tempfile.mkdtemp(prefix="board-habit-")
    was_dir, gate.bc.HABIT_DIR = gate.bc.HABIT_DIR, tmp
    # The gate is held on for its own cases, both reaches of the switch: on a machine
    # where it is thrown, every case below would otherwise be run against a gate that
    # stands aside, and the suite would go red for using its own way out.
    was_var = os.environ.pop(gate.bc.HABIT_OFF_VAR, None)
    was_off = gate.bc.HABIT_OFF_FILE
    gate.bc.HABIT_OFF_FILE = os.path.join(tmp, os.path.basename(was_off))
    try:
        YES = {"state": "read", "habit": True, "what": NAMED}
        said, fired = pointed_at(YES)
        assert "how you work" in said and NAMED in said, \
            "the manager pointed at a habit and the reply ended with nothing on the " \
            "board naming what produced it: %s" % (said or "ALLOWED")
        # The pour by the name THIS project's session types it: a project carrying a
        # forwarder is told its own path, one without is told the machinery's.
        assert "%s find" % project.tool(DECL, "job") in said and "--kind bug" in said, \
            "the refusal did not name the command that files the cause: %s" % said
        assert fired == ["habit-cause"], \
            "the refusal fired without counting, so the manager's number stays a " \
            "guess: %s" % fired

        filed, fired = pointed_at(YES, made=["tst-x.7"])
        assert filed == "" and not fired, \
            "the turn filed the cause and was refused anyway: %s" % filed

        # Every shape of not-a-yes, including the three that are not an answer at
        # all. A gate that cannot be sure lets the reply through: a wrong refusal
        # costs him a blocked message, which is worse than a habit missed.
        for what, verdict in (
                ("read him and said no", {"state": "read", "habit": False}),
                ("never got past the free word screen",
                 {"state": "screened", "habit": False}),
                ("could not be spent at all", {"state": "failed", "habit": False}),
                ("left nothing on the disk", None),
                ("left a torn write", "}{ not json at all"),
                ("left JSON that is not an answer", "[1, 2, 3]"),
                ("left a verdict that is not a boolean",
                 {"state": "read", "habit": "yes"})):
            said, fired = pointed_at(verdict)
            assert said == "" and not fired, \
                "a turn was refused on a reading that %s: %s" % (what, said)

        # A reading still running when the turn ends. Cut to a fifth of a second
        # here; in production it is the 20s a 5-8s reading almost never needs.
        was_wait, gate.HABIT_WAIT = gate.HABIT_WAIT, 0.2
        try:
            said, _ = pointed_at({"state": "reading", "habit": False})
            assert said == "", "a reading still running held the turn shut: %s" % said
        finally:
            gate.HABIT_WAIT = was_wait

        # The way out, both reaches of it (docs/board.md#habit). Each has to stop the
        # refusal AND the paid reading in front of it, or the switch buys him nothing.
        for what, throw, drop in (
                ("the variable",
                 lambda: os.environ.update({gate.bc.HABIT_OFF_VAR: "1"}),
                 lambda: os.environ.pop(gate.bc.HABIT_OFF_VAR, None)),
                ("the file",
                 lambda: open(gate.bc.HABIT_OFF_FILE, "w").close(),
                 lambda: os.remove(gate.bc.HABIT_OFF_FILE))):
            throw()
            try:
                said, fired = pointed_at(YES)
                assert said == "" and not fired, \
                    "%s was thrown and the refusal fired anyway: %s" % (what, said)
                left, fired, spawned, _ = reading_on(HIS_COMPLAINT, prompt="switched-off")
                assert not left and not spawned and not fired, \
                    "%s was thrown and his message was read anyway: %s" % (what, left)
            finally:
                drop()

        # The screen in front of the reading. His own complaint is the case that
        # matters: it carries none of the words a list of 'always, keeps, again'
        # would have been built from.
        assert reading.SCREEN.search(HIS_COMPLAINT), \
            "the screen reads the manager's own complaint as ordinary prose, so no " \
            "reading is ever paid for and the gate never fires"
        for line in ("You keep giving me a wall of text.",
                     "Again you closed the card without the report link.",
                     "why do you always start writing code before I approved the plan",
                     "You do this on every job.",
                     "I have told you this before."):
            assert reading.SCREEN.search(line), \
                "a complaint about a habit was never read: %r" % line
        for line in ("Add a debug view for the shadow cascades.",
                     "What does the cook do with the normal map?",
                     "That number is wrong, it should be 2.2 not 2.4.",
                     "Fix the reflection blur, it garbles."):
            assert not reading.SCREEN.search(line), \
                "an ordinary message was sent to a paid reading: %r" % line

        left, fired, spawned, injected = reading_on(HIS_COMPLAINT)
        assert left.get("state") == "reading" and spawned, \
            "his complaint was screened in and no reading was fired: %s" % left
        assert injected == "", \
            "the reading put something into the session, so the agent is told it " \
            "is being read: %r" % injected
        assert fired == ["turns-seen"], \
            "the turn the reading looked at was not counted, so the manager's " \
            "denominator stays an estimate: %s" % fired

        left, fired, spawned, _ = reading_on("Add a debug view for the shadow cascades.")
        assert left.get("state") == "screened" and not spawned, \
            "an ordinary message was sent to a paid reading: %s" % left
        assert fired == ["turns-seen"], \
            "a turn the reading looked at and let past was not counted: %s" % fired
    finally:
        gate.bc.HABIT_DIR, gate.bc.HABIT_OFF_FILE = was_dir, was_off
        if was_var is not None:
            os.environ[gate.bc.HABIT_OFF_VAR] = was_var
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a habit the manager points at cannot end the turn with nothing on the "
          "board naming what produced it, a card in the same turn satisfies it, every "
          "reading that is not a plain yes lets the reply through, and either way of "
          "switching the gate off stops the refusal and the reading both")

    his = landing("manager")
    assert any(a.startswith("update j -s manager_review") for a in his), \
        "a job the manager signs did not reach his column when it landed: %s" % his
    assert any("waiting on the manager" in a for a in his), \
        "his column got a card with nothing said about what he is looking at: %s" % his

    ours = landing("agent")
    assert not any("manager_review" in a for a in ours), \
        "a job no manager signs was parked in his column anyway: %s" % ours

    print("ok: landing puts a job the manager signs in his column, and only that job")

    waiting = {"status": "manager_review", "labels": ["job"], "issue_type": "epic"}
    ordinary = {"status": "in_progress", "labels": ["job"], "issue_type": "epic"}
    for cmd in ('bd close tst-t1 --reason="it is done"', "bd update tst-t1 -s open"):
        assert "waiting on the manager" in refusal(cmd, waiting), \
            "a session was allowed to move a card out of his column: %s" % cmd
        assert "waiting on the manager" not in refusal(cmd, ordinary), \
            "an ordinary card was refused as if it were his: %s" % cmd

    print("ok: his column is shut in both directions, and only his")

    # One list of carrier words, read by both gates, and taken off the same way.
    # Kept twice they drift, and a prefix the line guard refuses the close gate
    # lets straight through — which is what a carrier's OWN switches did.
    CARRIED = tuple(status.bc.WRAPPERS) + (
        "nice -n 10", "timeout 60", "sudo -u me", "stdbuf -oL",
        "env GIT_AUTHOR_NAME=me nice -n 5", "timeout --signal=KILL 30",
    )
    for word in CARRIED:
        said = refusal('%s git commit -m "x"' % word, ordinary)
        assert "name the card" in said, \
            "a commit carried by %r walked past the close gate without naming " \
            "its card: %s" % (word, said or "allowed")

    # A commit is read through the shared reader, so every way of writing one
    # reaches the same rule: git's own leading switches in both spellings, and a
    # command written behind one of the shell's own words.
    for spelled in ('git -C . commit -m "x"', 'git -c user.email=t@t commit -m "x"',
                    'git --work-tree=. commit -m "x"',
                    'if true; then git commit -m "x"; fi',
                    'if ! git diff --quiet; then git commit -m "x"; fi',
                    'for f in a; do git commit -m "x"; done'):
        said = refusal(spelled, ordinary)
        assert "name the card" in said, \
            "a commit written as %r walked past the rule that a commit names its " \
            "card: %s" % (spelled, said or "allowed")

    # And the board's own commands answer the same, behind a carrier word or
    # behind one of the shell's: a prefix a gate does not strip is a prefix that
    # walks around it, whichever gate and whichever prefix.
    for carried in ("nice -n 10", "sudo -u me", "timeout 60",
                    "if true; then", "while sleep 0; do", "for f in a; do", "!"):
        said = refusal("%s bd close tst-t1 --reason=done" % carried, waiting)
        assert "waiting on the manager" in said, \
            "a board command carried by %r walked past the close rule: %s" \
            % (carried, said or "allowed")

    # And a commit written as a substitution or handed to eval is a commit. The
    # pattern this rule replaced caught the bracket form; the shared reading has
    # to catch it too, or the change traded one hole for another.
    for hidden in ('$(git commit -m "x")', '`git commit -m "x"`',
                   'eval "git commit -m x"', 'echo $(git commit -m "x")'):
        said = refusal(hidden, ordinary)
        assert "name the card" in said, \
            "a commit written as %r walked past the rule that a commit names " \
            "its card: %s" % (hidden, said or "allowed")

    # A message that arrives on standard input names its card there too. The
    # reader drops a here-document body as data, which is right for deciding what
    # RAN and wrong for deciding what a commit is called: the id is read off the
    # line as typed.
    named = "git commit -F - <<'EOF'\ntst-t1 what this lands\nEOF"
    assert refusal(named, ordinary) == "", \
        "a commit whose message arrives on standard input was refused for naming " \
        "no card, while naming one: %s" % refusal(named, ordinary)
    blank = "git commit -F - <<'EOF'\nwhat this lands, naming nothing\nEOF"
    assert "name the card" in refusal(blank, ordinary), \
        "a commit naming no card was let through because its message was on " \
        "standard input: %s" % (refusal(blank, ordinary) or "allowed")

    # A commit whose message is in a file names its card there. Read only off the
    # line, every such commit is refused with no way through — the gate stopping
    # correct work, which is worse than the work it was built to stop.
    held = tempfile.mkdtemp(prefix="board-msg-")
    try:
        named = os.path.join(held, "msg.txt")
        with open(named, "w") as fh:
            fh.write("fix(x): tst-t1 what this lands\n")
        blank = os.path.join(held, "empty.txt")
        with open(blank, "w") as fh:
            fh.write("fix(x): what this lands, naming nothing\n")
        for spelled, want in ((["-F", named], ""), (["--file=" + named], ""),
                              (["-F", blank], "name the card"),
                              (["-F", os.path.join(held, "gone.txt")], "name the card")):
            said = refusal("git commit " + " ".join(spelled), ordinary)
            assert want in said and (want or not said), \
                "a commit whose message is in a file was judged wrongly (%s): %s" \
                % (" ".join(spelled), said or "allowed")
    finally:
        shutil.rmtree(held, ignore_errors=True)

    # A shell handed a command line is handed a command line. Everywhere else in
    # this gate a quoted word is a card's own text, which is what would hide this.
    for handed in ('sh -c "git commit -m x"', 'bash -lc "git commit -m x"',
                   'nice -n 10 sh -euc "git commit -m x"',
                   'sh -c "cd /tmp && git commit -m x"'):
        said = refusal(handed, ordinary)
        assert "name the card" in said, \
            "a commit handed to a shell as %r walked past the close gate: %s" \
            % (handed, said or "allowed")

    # And the words a card actually carries stay words: a note quoting a commit
    # is not a commit, or the gate refuses every note that describes one.
    quoted = refusal('bd update tst-t1 --append-notes="ran git commit -m x here"',
                     ordinary)
    assert "name the card" not in quoted, \
        "a note quoting a commit was read as one: %s" % quoted

    # Unwrapping a shell puts each command on a line of its own, and a rule that
    # ran to the next separator would then run across two commands: a listing
    # that merely mentions a status is judged as the status change beside it.
    claimable = {"status": "open", "labels": ["area:board"], "issue_type": "task"}
    listing = refusal("bd update tst-t1 --claim && bd list --status closed",
                      claimable)
    assert listing == "", \
        "an ordinary listing was judged as a close because the claim beside it " \
        "was on the same line: %s" % listing
    still = refusal("bd update tst-t1 --claim && bd close tst-t1 --reason=done",
                    waiting)
    assert "waiting on the manager" in still, \
        "a close on the second command of a line stopped being seen: %s" \
        % (still or "allowed")

    print("ok: a commit names its card behind every word that merely carries it "
          "and behind a shell it is handed to, both gates read that list from one "
          "place, and a card's own words are still words")

    tmp = tempfile.mkdtemp(prefix="board-selftest-")
    try:
        second = scratch_repo(tmp, unmerged=True)
        # The hook runs in front of every command and walks a log of hundreds of
        # edits: the register of checkouts is one answer, asked once.
        real_git, asked = status.git, []
        status.git = lambda args, where: (asked.append(args[0]), real_git(args, where))[1]
        status._ASKED.clear()
        standing(tmp, tmp, second)
        registers = asked.count("worktree")
        status.git = real_git
        assert registers == 1, "the register of checkouts was read %d times" % registers
        want = ["committed-not-merged", "landed-here", "landed-other-job",
                "landed-under-both", "left-dirty", "vendored", "worktree-dirty"]
        for root, where in ((tmp, "its own tree"), (second, "a second tree")):
            got = standing(root, tmp, second)
            assert got == want, "judged from %s, the gate counted: %s" % (where, got)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a no-code step is held to what it left standing — not to what it "
          "touched, and not to which tree the question is asked from")

    assert names("j.2.1") == ["j.2.1", "j.2"], \
        "a work item was not landed by the commit that landed its step: %s" % names("j.2.1")
    assert names("j.4") == ["j.4"], \
        "a work item hanging off the goal was landed by the goal: %s" % names("j.4")
    assert names("j.2") == ["j.2", "j"], \
        "a step lost the goal-wide allowance, or kept it twice: %s" % names("j.2")

    assert names("j.2.1", blind=True) == ["j.2.1"], \
        "the widening outlived the walk that reads it, so the case above proves " \
        "nothing: %s" % names("j.2.1", blind=True)

    print("ok: a step's commit lands the work items under it, the goal's lands none "
          "of them, a step keeps what it had, and the first of those goes red with "
          "the walk taken out")

    tmp = tempfile.mkdtemp(prefix="board-teardown-")
    try:
        copy = scratch_repo(tmp)
        # The gate stands aside for a directory that holds no board at all.
        os.makedirs(os.path.join(tmp, ".beads"), exist_ok=True)
        # Every branch this project cuts is named `fix/…` or `feat/…`, and the
        # route ends by deleting one: a name cut at its last slash is no branch
        # at all, so the case is run against the shape that has one.
        subprocess.run(["git", "branch", "-m", "fix/second"], cwd=copy,
                       capture_output=True)

        open(os.path.join(copy, "left-behind"), "w").write("uncommitted\n")
        said = teardown(tmp)
        assert "holds work nobody committed" in said and "left-behind" in said, \
            "a copy with loose work was not named as the reason: %s" % said
        assert os.path.isdir(copy), "the gate deleted a copy instead of refusing"

        # Everything the scratch copy was given, including what the case above it
        # leaves there: the next case is about a copy with nothing loose in it.
        for line in subprocess.run(["git", "status", "--porcelain"], cwd=copy,
                                   capture_output=True, text=True).stdout.splitlines():
            os.remove(os.path.join(copy, line[3:].strip()))
        said = teardown(tmp)
        assert "still on the disk" in said, \
            "the teardown closed with its copy still there: %s" % (said or "ALLOWED")
        route = said.rsplit("\n", 1)[-1].strip()
        assert route.startswith("rm -rf ") and "worktree prune" in route, \
            "the refusal printed a route nobody can follow: %s" % route
        assert route.endswith(" branch -d fix/second"), \
            "the route named a branch that does not exist: %s" % route

        # A board that answered nothing is not a board that said 'no copies':
        # read the two as the same and the rule switches itself off in silence.
        blind = teardown(tmp, answers=False)
        assert "could not say" in blind, \
            "a board that could not answer was read as a clean bill: %s" \
            % (blind or "ALLOWED")

        subprocess.run(route, shell=True, capture_output=True)
        assert not os.path.isdir(copy), "the printed route did not remove the copy"
        assert teardown(tmp) == "", \
            "the teardown was still refused once its copy was gone: %s" % teardown(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a job cannot finish while its copy is on the disk, loose work is "
          "named rather than destroyed, and the route it prints is one that works")

    tmp = tempfile.mkdtemp(prefix="board-nextjob-")
    try:
        scratch_repo(tmp)
        os.makedirs(os.path.join(tmp, ".beads"), exist_ok=True)
        spent = next_job(tmp, work_left=False)
        assert "nothing left to build in it" in spent and "tst-old" in spent, \
            "a session started a new job while its finished one's copy stood: %s" \
            % (spent or "ALLOWED")
        building = next_job(tmp, work_left=True)
        assert building == "", \
            "a session was refused a new job over a copy it is still building " \
            "in: %s" % building
        # A goal poured before an order was recorded says nothing about whether
        # its work is done, and the same empty answer comes back from a board
        # that hiccuped. Reading either as 'finished' refuses for no reason.
        unknown = next_job(tmp, work_left=False, order="")
        assert unknown == "", \
            "a job whose order was never recorded was read as finished: %s" % unknown

        part = next_job(tmp, work_left=True, half=True)
        assert part == "", \
            "a stage with one piece closed and one still open was read as built, " \
            "so its owner was refused the next job: %s" % part

        under_reading = claim_of(tmp, {
            "tst-j.1": [{"id": "tst-j", "status": "open", "issue_type": "epic",
                         "dependency_type": "parent-child"}],
            "tst-j": [{"id": "tst-g", "status": "open", "issue_type": "gate",
                       "title": runner.GATE_TITLE}]})
        assert under_reading == "", \
            "the refusal itself still turns away a piece held only by its own " \
            "job's reading: %s" % under_reading
        ordinary = claim_of(tmp, {
            "tst-j.1": [{"id": "tst-k", "status": "open", "issue_type": "task",
                         "dependency_type": "blocks"}]})
        assert "waiting on something else" in ordinary, \
            "a piece waiting on an ordinary card was let through by the refusal " \
            "itself: %s" % (ordinary or "ALLOWED")

        bad = flags_are_real(tmp)
        assert bad != "" if bad is None else bad == "", \
            "bd does not accept the query both refusals rest on, so they are off " \
            "in production while every case here still passes: %s" % bad
        if bad is None:
            print("   (bd could not make a throwaway board here; the flags were "
                  "not pinned against the real one this run)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a session cannot start a new job while it still owns a finished "
          "one's copy, is left alone while that copy is still being built in, and "
          "a stage with one piece closed and one open still counts as building")

    UNDER = [{"id": "tst-j", "status": "open", "issue_type": "epic",
              "dependency_type": "parent-child"}]
    SHUT = {"tst-j.1": UNDER,
            "tst-j": [{"id": "tst-g", "status": "open", "issue_type": "gate",
                       "title": READING}]}
    assert excused(SHUT), \
        "a piece of a job its own reading shut is still waiting, so the answers " \
        "that reading asked for can never be started"
    assert not excused(SHUT, cid="tst-j"), \
        "the shut job itself was excused: its reading waits for a reader, not " \
        "for the job to be picked up"
    assert not excused({"tst-j.1": UNDER, "tst-j": [
        {"id": "tst-g", "status": "open", "issue_type": "gate",
         "title": "Gate: the manager has not said yes"}]}), \
        "a job held by a gate that is not a reading was excused anyway"
    assert not excused({"tst-j.1": [{"id": "tst-k", "status": "open",
                                     "issue_type": "task",
                                     "dependency_type": "blocks"}]}), \
        "a piece waiting on an ordinary card was let through"
    assert not excused({"tst-j.1": UNDER, "tst-j": [
        {"id": "tst-g", "status": "closed", "issue_type": "gate",
         "title": READING}]}), \
        "a reading already passed still excused the piece, so nothing is left " \
        "holding the job"
    assert not excused(SHUT, answers=False), \
        "the board did not answer and the claim was let through anyway: a check " \
        "that cannot run is not a check that passed"

    print("ok: a piece held only by the reading of its own job can be picked up, "
          "and a piece held by anything else — an ordinary card, another kind of "
          "gate, its own reading, or a board that did not answer — cannot")

    tmp = tempfile.mkdtemp(prefix="board-census-")
    try:
        copy = scratch_repo(tmp)
        for line in subprocess.run(["git", "status", "--porcelain"], cwd=copy,
                                   capture_output=True, text=True).stdout.splitlines():
            os.remove(os.path.join(copy, line[3:].strip()))

        # Nobody is in it and no session of its own is alive: the two refusals in
        # the gate would never hear about this copy, which is how they all piled up.
        code, said = census(tmp, busy=set())
        assert code == 1 and "SPENT" in said and copy in said, \
            "a copy whose session is gone was not named: %s" % said

        code, said = census(tmp, busy={os.path.basename(copy)})
        assert code == 0 and "SPENT" not in said, \
            "a copy somebody is working in was called spent: %s" % said

        open(os.path.join(copy, "still-here"), "w").write("uncommitted\n")
        code, said = census(tmp, busy=set())
        assert code == 0 and "SPENT" not in said, \
            "a copy holding uncommitted work was called spent: %s" % said
        assert os.path.isdir(copy), "the census removed a copy instead of naming it"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a copy nobody is in and whose work has landed is named however "
          "long its session has been gone, and one still holding work is not")

    tmp = tempfile.mkdtemp(prefix="board-submodule-")
    try:
        tree = submodule_copy(tmp)
        refused = subprocess.run(["git", "worktree", "remove", tree], cwd=tmp,
                                 capture_output=True, text=True)
        assert refused.returncode != 0 and "submodule" in refused.stderr, \
            "git accepted `worktree remove` on a copy with a submodule, so the " \
            "reason this refusal prints a different route no longer holds: %s" \
            % refused.stderr
        subprocess.run(status.removal(tree, "withsub", tmp), shell=True,
                       capture_output=True)
        assert not os.path.isdir(tree), \
            "the printed route failed on the shape of copy this project actually makes"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: git refuses `worktree remove` for a copy carrying a submodule, and "
          "the route the refusal prints removes it anyway")

    pin()

    # The words a card reaches the manager in. Every pour below runs with `bd`
    # taken off the path, so a refusal that fires proves the check ran BEFORE the
    # board was touched — the cases leave nothing behind, and a check that had been
    # dropped would fail on a missing `bd` instead, which reads differently.
    def pour(args):
        env = dict(os.environ, PATH=os.path.join(HOME, "no-such-bin"))
        run = subprocess.run([sys.executable, os.path.join(HOME, "board", "job")]
                             + args, capture_output=True, text=True, env=env, cwd=ROOT)
        return run.returncode, (run.stdout or "") + (run.stderr or "")

    UNREADABLE = "the shader pass writes the framebuffer"
    READABLE = "The manager cannot tell finished work from work still running"
    WORDS = "words of whoever built the thing"
    WHERE = "scripts/board/job prints the same sentence into every card"
    DONE = "`cargo test` reports 0 failures"
    NOT_IN = "the words a card is written in (%s)" % bars.EG_CARD

    code, said = pour(["find", UNREADABLE, WHERE,
                       "--area", AREA, "--kind", "bug"])
    assert code != 0 and WORDS in said, \
        "a find whose title only its author can read was not refused: %s" % said
    for term, plain_word in (("shader", "colours a surface"), ("pass", "step"),
                             ("framebuffer", "picture being drawn")):
        assert term in said and plain_word in said, \
            "the refusal named %r without saying what to write instead: %s" % (term, said)

    code, said = pour(["find", READABLE, WHERE,
                       "--area", LAST_AREA, "--kind", "bug"])
    assert WORDS not in said, "a find anyone can read was refused anyway: %s" % said

    # The shapes code leaves behind carry no banned word at all, and they are how
    # most of this board's unreadable titles are actually written: 140 of 566 on
    # the day this landed, most of them a file name or a run-together name.
    for line, shape in (("board-merge-gate.py stands aside", "a file name"),
                        ("arm_review swallows the failure", "a run-together code name"),
                        ("close_gate() never fires", "call syntax"),
                        ("The GPU budget is never read", "shouted initials")):
        code, said = pour(["find", line, WHERE,
                           "--area", LAST_AREA, "--kind", "bug"])
        assert code != 0 and shape in said, \
            "a title written as %s was accepted: %s" % (shape, said)

    for shape in (["new", "--what", UNREADABLE, "--evidence", "x" * 40,
                   "--done", DONE, "--not", NOT_IN, "--area", AREA,
                   "--kind", "bug", "--judge", "agent", "--steps", "design",
                   "--skip", "ground=nothing outside this tree defines it here",
                   "--skip", "test=the check below is itself the guard for this"],
                  ["epic", "--what", UNREADABLE, "--evidence", "x" * 40,
                   "--done", DONE, "--area", AREA, "--kind", "bug"],
                  ["under", "g", "--do", "%s|%s" % (UNREADABLE, DONE)]):
        code, said = pour(shape)
        assert code != 0 and WORDS in said, \
            "`job %s` accepted a line only its author can read: %s" % (shape[0], said)

    # A word list that cannot be read refuses rather than waves through: a check
    # that could not run is not a check that passed.
    import plain as plain_words
    was, plain_words.bc.reports_dir = plain_words.bc.reports_dir, lambda: "/nonexistent"
    kept, sys.path = sys.path, [p for p in sys.path if "beads-web" not in p]
    sys.modules.pop("jargon", None)
    try:
        try:
            plain_words.refuse("any words at all", "A ticket")
            raise AssertionError("a missing word list waved the card through")
        except SystemExit as stop:
            assert "could not run is not a check that passed" in str(stop), \
                "the missing word list refused for the wrong reason: %s" % stop
    finally:
        plain_words.bc.reports_dir, sys.path = was, kept

    print("ok: a card whose manager-facing line is written in the words of whoever "
          "built the thing is refused at every pour, told which plain word to use, "
          "and refused too when the word list itself cannot be read")

    # Where a card belongs. Both halves are needed: 198 cards about the shared
    # tools reached one project's board because a subject it did not own was still
    # accepted, and 52 of those arrived under a subject it does own, which is why
    # the second half reads the evidence for a place instead of reading the tag.
    elsewhere = {n: project.of(p) for n, p in project.registry().items()
                 if os.path.realpath(p) != os.path.realpath(ROOT)}
    theirs = sorted((a, n) for n, d in elsewhere.items() for a in d.areas
                    if a not in DECL.areas)
    if theirs:
        area, owner = theirs[0]
        code, said = pour(["find", READABLE, WHERE, "--area", area, "--kind", "bug"])
        assert code != 0 and owner in said and elsewhere[owner].path in said, \
            "a card filed here under %r, which is %s's subject and not this " \
            "project's, was not routed there: %s" % (area, owner, said)

    for owner, decl in sorted(elsewhere.items()):
        code, said = pour(["find", READABLE,
                           "%s, in %s" % (WHERE, os.path.realpath(decl.path)),
                           "--area", LAST_AREA, "--kind", "bug"])
        assert code != 0 and owner in said, \
            "a card whose evidence names %s's own checkout was filed here: %s" \
            % (owner, said)

    # And a card that belongs here is not caught by either half — a router that
    # refuses everything routes nothing.
    code, said = pour(["find", READABLE, WHERE, "--area", LAST_AREA, "--kind", "bug"])
    assert "file it there" not in said, \
        "a card about this project's own %s was sent somewhere else: %s" \
        % (LAST_AREA, said)
    assert "No such file or directory: 'bd'" in said, \
        "a card that belongs here never reached the board: %s" % said

    print("ok: a card is refused and routed when its subject belongs to another "
          "project and when its evidence names another project's checkout, and a "
          "card that belongs here reaches the board")

    # What each section of a card has to carry. Same arrangement: `bd` is off the
    # path, so a refusal proves the bar ran before anything was written.
    def job_new(**over):
        args = {"--what": READABLE, "--evidence": "x" * 40, "--done": DONE,
                "--not": NOT_IN, "--area": LAST_AREA, "--kind": "bug",
                "--judge": "agent", "--steps": "design"}
        args.update(over)
        flat = ["new"]
        for flag, value in args.items():
            if value is not None:
                flat += [flag, value]
        return pour(flat + ["--skip", "ground=nothing outside this tree defines it",
                            "--skip", "test=this suite is itself the guard for it"])

    for name, over, wanted in (
            ("a goal stated as its own fix", {"--what": "Fix the lamp"},
             "instruction, not something anyone can go and look at"),
            ("a goal whose whole claim is an adjective", {"--what": "The board is bad"},
             "an adjective, so there is nothing to go and look for"),
            ("a finish line naming nothing to run", {"--done": "e.g. it works"},
             "names nothing anyone can run"),
            ("a finish line with no outcome", {"--done": "`cargo test` runs"},
             "nothing it must produce"),
            ("a finish line with a hedge beside the command",
             {"--done": "`cargo test` passes and the picture looks good enough"},
             "hedges"),
            ("a job that never says what it leaves out", {"--not": None},
             "must say what this job deliberately leaves out"),
            ("a job whose scope line is the sentence the pour used to print",
             {"--not": "Anything found on the way becomes its own card."},
             "the sentence the pour used to print"),
            ("a job whose scope line names nothing", {"--not": "other stuff"},
             "names nothing anyone could check the job against")):
        code, said = job_new(**over)
        assert code != 0 and wanted in said, "%s was accepted: %s" % (name, said)
        assert "not \"" in said or "  but " in said or "Name the" in said, \
            "%s was refused without saying what to write instead: %s" % (name, said)

    code, said = pour(["under", "g", "--do", "Draw the lamp|it works"])
    assert code != 0 and "names nothing anyone can run" in said, \
        "a work item's finish line was held to a length rather than to its parent's " \
        "bar: %s" % said

    for name, where, wanted in (
            ("a find that says where it is but not how it shows",
             "scripts/board/job, on every pour", "not HOW IT SHOWS"),
            ("a find that says neither", "over there", "must say WHERE it is")):
        code, said = pour(["find", READABLE, where, "--area", LAST_AREA, "--kind", "bug"])
        assert code != 0 and wanted in said, "%s was accepted: %s" % (name, said)

    code, said = job_new()
    assert "must say" not in said and "names nothing" not in said, \
        "a job with every section filled properly was refused anyway: %s" % said

    # Both kinds carried all the way past their bars, not only up to them: the cases
    # above stop at the refusal, so a card the bars let through went to the board
    # untried and a fault in what it writes there showed up on somebody's real find.
    for kind, args in (("a job", []),
                       ("a find", ["find", READABLE, WHERE,
                                   "--area", LAST_AREA, "--kind", "bug"])):
        _, said = (job_new() if not args else pour(args))
        # `bd` is off the path for every case here, so reaching the board command is
        # the pass — the card's whole body was built first. Stopping anywhere earlier
        # is the fault this catches.
        assert "No such file or directory: 'bd'" in said, \
            "%s that cleared every bar never reached the board: %s" % (kind, said)

    print("ok: a card is refused unless what is wrong is observable, the finish line "
          "names a run and its outcome, the scope line was written for this job, a "
          "work item is held to its parent's bar, and a find says where and how")

    # What a job costs before it is allowed to start. Eleven steps, of which four
    # were ceremony a job paid in cards: a worktree card for a tree the gates
    # already demand, a clarify and a prove card for what the pour had just asked
    # for in --what and --evidence, a verify card and a guard card for two halves
    # of one command. The run is work, checks, review, land, and the rest arrive
    # only when the job says so (bw-510, bw-a6o.2).
    #
    # The real pour, run against a `bd` that answers and writes down what it was
    # asked — the order is what the goal is stamped with, not what a helper here
    # recomputes.
    tmp = tempfile.mkdtemp(prefix="board-pour-")
    try:
        stub = os.path.join(tmp, "bd")
        with open(stub, "w") as fh:
            fh.write("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BD_LOG\"\n"
                     "case \"$*\" in *--json*) echo '{\"id\":\"tst-poured\"}';; esac\n")
        os.chmod(stub, 0o755)
        log = os.path.join(tmp, "asked.log")

        def poured(*extra, **over):
            open(log, "w").close()
            args = {"--what": READABLE, "--evidence": "x" * 40, "--done": DONE,
                    "--not": NOT_IN, "--area": LAST_AREA, "--kind": "bug",
                    "--judge": "agent"}
            args.update(over)
            flat = ["new"]
            for flag, value in args.items():
                if value is not None:
                    flat += [flag, value]
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ["PATH"],
                       BD_LOG=log)
            run = subprocess.run([sys.executable, os.path.join(HOME, "board", "job")]
                                 + flat + list(extra), capture_output=True, text=True,
                                 env=env, cwd=ROOT)
            said = (run.stdout or "") + (run.stderr or "")
            return run.returncode, said, open(log).read().splitlines()

        code, said, asked = poured()
        assert code == 0, "a pour that named no steps at all was refused: %s" % said
        assert "runs: work → checks → review → land" in said, \
            "a job that asked for nothing extra runs something other than its work, " \
            "its checks, its reading and its landing: %s" % said
        assert any("spine=work,checks,review,land" in line for line in asked), \
            "the goal was stamped with an order other than the one it printed: %s" % asked
        made = [l for l in asked if l.startswith("create ")]
        assert len(made) == 1, \
            "a job that has not been designed yet already has %d cards on the board, " \
            "which is the ceremony the cut removed: %s" % (len(made), made)
        assert "no first step to open" in said, \
            "the pour opened a card at a position whose cards are the job's own work " \
            "items: %s" % said
        if DECL.checks:
            assert any("checks=" + DECL.checks in line for line in asked), \
                "the goal does not carry this project's checks command, so the step " \
                "opened weeks later by a session standing somewhere else has no way " \
                "to name it: %s" % asked

        # The optional steps, which arrive two ways and no other: named, or asked
        # for by the job's own words. Nothing is owed in writing.
        code, said, asked = poured("--steps", "ground,design")
        assert code == 0 and "runs: ground → design → work → checks → review → land" \
            in said, "a job that named two optional steps did not get them: %s" % said
        assert len([l for l in asked if l.startswith("create ")]) == 2, \
            "a job whose run opens at a step of its own got no card for it: %s" % asked

        _, said, _ = poured(**{"--done": "`cargo bench` reports the draw at 8 ms, "
                                         "down from 30 ms"})
        assert "benchmark" in said, \
            "a job claiming a speed win was poured with nothing measuring it: %s" % said
        _, said, _ = poured(**{"--done": "`cargo test` reports 0 failures with "
                                         "docs/board.md rewritten to match"})
        assert "record" in said, \
            "a job whose finish line names the document it writes was poured with " \
            "nothing writing it: %s" % said
        _, said, _ = poured("--record", "docs/board.md")
        assert "record" in said, \
            "a job handed the document it writes was poured with nothing writing " \
            "it: %s" % said

        # An old caller, and a new one asking for what is gone. The pour written
        # while the board demanded a written refusal per step still runs; asking to
        # RUN a step the playbook no longer has is told what happened to it.
        code, said, _ = poured("--skip", "test=this suite is itself the guard for it")
        assert code == 0 and "runs: work → checks → review → land" in said, \
            "a pour written while the board demanded a refusal per step stopped " \
            "working: %s" % said
        code, said, _ = poured("--steps", "guard")
        assert code != 0 and "not a step of the playbook any more" in said, \
            "a job was poured with a step nothing opens, closes or proves: %s" % said
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # A job already running keeps the order written on its own goal. The catalogue
    # answers for every id those goals carry — a position it cannot answer for is a
    # job that stops moving mid-run, with no card and nothing to open next.
    OLD = "worktree,clarify,prove,ground,design,build,verify,benchmark,test,review,record,land"
    for sid in spine.stored(OLD):
        assert sid in spine.BY_ID, \
            "a job poured under the old playbook carries %r, which the catalogue no " \
            "longer answers for, so its run stops where it stands" % sid
        assert spine.evidence(sid) and spine.tier(sid), \
            "%s has no proof or no tier, so the close gate reads it as a commit step" % sid
    assert spine.card("verify", "g", {"done": "x"}, 1), \
        "an in-flight job cannot be handed the card its own order says comes next"
    assert not set(spine.stored(OLD)) & set(spine.ORDER) - set(spine.order([])) - \
        {"ground", "design", "benchmark", "record"}, \
        "the cut left a retired step in the run a job is poured with"
    assert [s for s in spine.stored(OLD) if spine.tier(s) == spine.GONE] == \
        ["worktree", "clarify", "prove", "verify", "test"], \
        "the steps the cut retired are not the ones the catalogue says it retired"

    # What closes the one step that replaced them. A step whose whole proof is a
    # note closes on what the note carries, and "the tests pass" is the sentence
    # every unrun suite has also been described with.
    ok, wanted = spine.note_ok("checks", "ran the tests and everything passed")
    assert not ok and "command" in wanted, \
        "the checks step closed on a claim that something was run, with no command " \
        "and no count: %s" % wanted
    assert spine.note_ok("checks", "`./check`: 0 failures, 100 faults red")[0], \
        "the checks step cannot be closed by the command it ran and what came back"

    print("ok: a job is poured with its work, its checks, its reading and its "
          "landing and nothing else, the optional steps arrive named or asked for by "
          "the job's own words, a pour that refuses a step in writing still runs, and "
          "a job already running keeps every position of its own order")

    # A bar nobody calls is a bar that is not there. The cases above catch a bar
    # removed from a path they cover; this catches one written and never wired,
    # which is how a section quietly goes back to accepting anything. Both ends are
    # held to the same list: the pour, which keeps a bad card off the board, and the
    # measurement, which says whether the cards already on it would be accepted.
    import inspect
    poured = open(os.path.join(HOME, "board", "job")).read()
    measured = inspect.getsource(bars.faults)
    public = [n for n in dir(bars) if not n.startswith("_") and n not in ("part", "faults",
              "kind_of", "use") and callable(getattr(bars, n))
              and getattr(bars, n).__module__ == "sections"]
    assert sorted(public) == sorted(bars.BARS), \
        "a bar exists that the list of bars does not name, so nothing holds it to " \
        "either end: %s" % sorted(set(public) ^ set(bars.BARS))
    for name in bars.BARS:
        assert "sections.%s(" % name in poured, \
            "sections.%s is a bar the pour never calls, so that section accepts " \
            "anything" % name
        assert "%s(" % name in measured, \
            "sections.%s is a bar the sweep never measures, so a card already " \
            "standing is never held to it" % name

    print("ok: every bar for a card's sections is one the pour calls and one the "
          "measurement of the standing board holds a card to")

    # A card already standing, measured by the same bars the pour runs. Cards here
    # are made up rather than read: the audit reads the real board, and a case that
    # went there would be measuring whatever the board happened to hold that day.
    GOOD_JOB = {"id": "x", "status": "open", "labels": ["job"],
                "metadata": {"done": "`cargo test` reports 0 failures"},
                "description": "## What is wrong\nThe lamp draws black at dusk\n\n"
                               "## Evidence it is real\nThe dusk render came back at "
                               "0.0 in the lamp's own window\n\n## Not in this job\n"
                               "the words a card is written in (%s)\n"
                               % bars.EG_CARD}
    assert not bars.faults(GOOD_JOB), \
        "a job with every section filled properly was called below the bar: %s" \
        % bars.faults(GOOD_JOB)
    for section, broken in (
            ("what", {"description": GOOD_JOB["description"].replace(
                "The lamp draws black at dusk", "Fix the lamp")}),
            ("evidence", {"description": GOOD_JOB["description"].replace(
                "The dusk render came back at 0.0 in the lamp's own window", "it is")}),
            ("done", {"metadata": {"done": "it works"}}),
            ("not_in", {"description": GOOD_JOB["description"].replace(
                "the words a card is written in (%s)" % bars.EG_CARD,
                "Anything found on the way becomes its own card.")})):
        assert section in bars.faults(dict(GOOD_JOB, **broken)), \
            "a job below the bar on %s was measured as being at it" % section
    assert "where" in bars.faults({"id": "y", "status": "open", "labels": ["find"],
                                   "description": "## Where it is\nover there\n"}), \
        "something filed in passing with no place named was measured as being at the bar"
    assert "done" in bars.faults({"id": "z", "status": "open", "labels": [],
                                  "acceptance_criteria": "it works"}), \
        "a work item finished by \"it works\" was measured as being at the bar"
    assert not bars.faults(dict(GOOD_JOB, labels=["step:verify", "of:x"])), \
        "the step cards the board writes for itself are being held to a bar meant " \
        "for cards a person wrote (cor-tg56)"

    print("ok: a card already standing is measured by the same bars the pour runs, "
          "on every section and every kind of card")

    # The sweep rewrites 221 cards, so what it may write is the whole question: one
    # allowed to write anything finishes by putting 221 fresh sentences that mean
    # nothing onto the board. Its own bar is read here without a board in reach.
    def loaded(name, path):
        spec = importlib.util.spec_from_loader(
            name, importlib.machinery.SourceFileLoader(name, os.path.join(
                HOME, "board", path)))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    sweeper = loaded("board_sweep", "sweep")
    pin()
    for kind, new, wanted in (
            ("job", {"done": "it works"}, "names nothing anyone can run"),
            ("job", {"not_in": "Anything found on the way becomes its own card."},
             "the sentence the pour used to print"),
            ("job", {"what": "Fix the lamp"}, "instruction, not something anyone can"),
            ("job", {"what": "the shader pass is slow"}, "words of whoever built"),
            ("find", {"where": "over there"}, "must say WHERE it is"),
            ("item", {"not_in": "nothing under shading"}, "has no not_in section")):
        said = " ".join(sweeper.refusals("c", kind, new))
        assert wanted in said, \
            "the sweep would have written a %s below the bar: %r" % (kind, said)

    assert not sweeper.refusals("c", "job", {
        "what": "The lamp draws black at dusk",
        "done": "`cargo test` reports 0 failures",
        "not_in": "the words a card is written in (%s)" % bars.EG_CARD}), \
        "a rewrite that clears every bar was refused anyway"

    print("ok: the sweep refuses to write a section that the pour would have refused "
          "on a new card")

    # The Opus worker answers the lead and nobody else. A rule that only ever runs
    # on calls it lets through proves nothing, so it is driven from both ends: the
    # case the manager caught, the case that must keep working, and everything the
    # rule must not touch.
    fence = os.path.join(HOME, "hooks", "agent-fence.py")

    def asks(subagent, caller=None, tool="Agent"):
        payload = {"tool_name": tool, "tool_input": {"subagent_type": subagent}}
        if caller:
            payload["agent_type"] = caller
        out = subprocess.run([sys.executable, fence], input=json.dumps(payload),
                             capture_output=True, text=True).stdout
        return json.loads(out)["hookSpecificOutput"] if out.strip() else None

    said = asks("builder")
    assert said and said["permissionDecision"] == "deny", \
        "a session that is not the lead asked for builder and was let through"
    assert "lead" in said["permissionDecisionReason"], \
        "builder was refused without naming the lead as the way through: %s" % said
    assert asks("builder", "scout") is not None, \
        "another agent asked for builder and was let through"
    assert asks("builder", "lead") is None, \
        "the lead asked for its own worker and was refused"
    for other in ("scout", "verify-render", "lead"):
        assert asks(other) is None and asks(other, "lead") is None, \
            "%s was caught by a rule that is only about builder" % other
    assert asks("builder", tool="Bash") is None, \
        "a call that is not the Agent tool was read as one"

    print("ok: the Opus worker is refused to everyone but the lead, and no other "
          "agent is touched")

    # The slot is taken in one tree and the merge run from another, which is what a
    # session doing this job actually does — so the hold is recognised by session
    # and not by the name the tree gave it.
    merge = hook("board-merge-gate")
    SID = "abcd1234-0000-0000-0000-000000000000"

    def merging(holder, here, cmd="git merge --ff-only work"):
        merge.bc.board_root = lambda cwd=None: ROOT
        merge.bc.actor = lambda sid, cwd: here
        # These cases are about the slot alone, so they stand on the line it
        # guards and no line is protected. Which line a command writes to, and
        # who may write to it, are their own questions and are answered by the
        # routes cases below — against a project of their own, so neither case
        # can be turned green or red by what this checkout happens to declare.
        merge.standing_on = lambda where: project.of(ROOT).lands_on
        merge.protected_by = lambda root: frozenset()
        merge.bc.bd = lambda args, root=None: (True, json.dumps({"holder": holder}))
        sys.stdin = io.StringIO(json.dumps({
            "session_id": SID, "cwd": ROOT, "tool_input": {"command": cmd}}))
        out = io.StringIO()
        keep, sys.stdout = sys.stdout, out
        try:
            merge.main()
        finally:
            sys.stdout = keep
        said = out.getvalue()
        return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"] \
            if said.strip() else ""

    assert merging("main-abcd1234", "main-abcd1234") == "", \
        "a session merging from the tree it took the slot in was refused its own hold"
    assert merging("worktree-abcd1234", "main-abcd1234") == "", \
        "a session that took the slot in its own copy was refused when it merged " \
        "from the main tree, which is the shape every landing here has"
    assert "not holding it" in merging("someone-99999999", "main-abcd1234"), \
        "somebody else's hold was read as this session's"
    assert "fast-forward" in merging("main-abcd1234", "main-abcd1234",
                                     cmd="git merge work"), \
        "a merge that is not a fast-forward was allowed to the slot's holder"
    # And asked of the fold being judged rather than of the whole line: a switch
    # on one command says nothing about the next one, and both land here.
    assert "fast-forward" in merging(
        "main-abcd1234", "main-abcd1234",
        cmd="git pull --ff-only origin main && git merge work"), \
        "a fast-forward switch typed on a different command excused a merge that " \
        "carries none, on the line every close is measured against"
    assert "fast-forward" in merging(
        "main-abcd1234", "main-abcd1234",
        cmd="git merge --ff-only one && git merge two"), \
        "a second merge rode onto the main line behind the first one's switch"
    # The slot queues folds. An ordinary commit on the main line resolves no
    # conflict with anybody and must not have to wait for one.
    assert merging("someone-99999999", "main-abcd1234", cmd="git commit -m x") == "", \
        "an ordinary commit on the main line was made to queue behind the merge " \
        "slot, which would stop every session committing in its own main tree"

    print("ok: the merge slot is recognised by the session holding it however many "
          "trees it works in, somebody else's hold is not, and a merge that would "
          "not fast-forward is refused to the holder as well")

    # What the slot was blind to until bw-7e8.4. A landing was refused, and the
    # line was then moved by hand — `git update-ref refs/heads/ours
    # refs/heads/bw-4gk` — which took the main line onto work nobody had landed.
    # The lines below are that incident and its neighbours: the spellings that
    # point the line somewhere are refused outright, because taking the slot
    # first would not have made any of them a landing; the spellings that fold
    # work in are held to the slot exactly as merge and rebase already are.
    LANDS = project.of(ROOT).lands_on
    MINE = "main-abcd1234"
    for pointed in ("git update-ref refs/heads/%s refs/heads/bw-4gk" % LANDS,
                    "git symbolic-ref refs/heads/%s refs/heads/x" % LANDS,
                    "git branch -f %s x" % LANDS,
                    # The one that names no line at all: a reset moves the line
                    # being stood on, and these cases stand on the landing line.
                    "git reset --hard x"):
        said = merging(MINE, MINE, cmd=pointed)
        assert "by hand" in said, \
            "%r pointed the line every close is measured against at a commit, " \
            "holding the slot, and was answered with %r" % (pointed, said)
    for fold in ("git push . x:%s", "git fetch . x:%s"):
        assert "not holding it" in merging("someone-99999999", MINE, cmd=fold % LANDS), \
            "%r moved the main line without the slot" % (fold % LANDS)
        assert merging(MINE, MINE, cmd=fold % LANDS) == "", \
            "%r was refused to the session holding the slot" % (fold % LANDS)
    assert merging("someone-99999999", MINE,
                   cmd="git update-ref refs/heads/anything-else x") == "", \
        "pointing a line of the agent's own at a commit was refused, and every " \
        "line but the one this project ships from is the agent's own business"

    # And the other side of the same word (bw-7e8.9). With one name on it and
    # nothing to point that name at, `symbolic-ref` ASKS where the name points
    # and prints the answer — which is what a session runs to find out which line
    # its shell is standing on, and these cases stand on the landing line, so
    # reading the question as the write refuses the truthful answer.
    for asked in ("git symbolic-ref HEAD",
                  "git symbolic-ref --short HEAD",
                  "git symbolic-ref -q --short HEAD"):
        said = merging(MINE, MINE, cmd=asked)
        assert said == "", \
            "%r asked where the shell stands, wrote nowhere, and was answered " \
            "with %r" % (asked, said)
    # The write that carries one name and no target is the delete, and it takes
    # the line away rather than moving it.
    for took in ("git symbolic-ref --delete refs/heads/%s" % LANDS,
                 "git symbolic-ref -d refs/heads/%s" % LANDS):
        said = merging(MINE, MINE, cmd=took)
        assert "by hand" in said, \
            "%r took the line every close is measured against away by hand, " \
            "holding the slot, and was answered with %r" % (took, said)

    # And the incident as it was actually typed, against a project shaped like the
    # one it happened in: landing on `ours`, with agents landing their own work so
    # nothing at all is protected. Gate A has nothing to say there, which is why
    # this had to be the slot's question rather than the protected list's.
    LIKE_IT = 'name = "x"\nprefix = "x"\nlands_on = "ours"\nagent_merges = true\n'
    said = merge_says("git update-ref refs/heads/ours refs/heads/bw-4gk",
                      says=LIKE_IT, on="ours", board=True)
    assert "by hand" in said and "merge-slot acquire" in said, \
        "the incident command was answered with %r" % said
    assert merge_says("git update-ref refs/heads/mine refs/heads/bw-4gk",
                      says=LIKE_IT, on="ours", board=True) == "", \
        "a line of the agent's own was refused in the project the incident happened in"
    # The two spellings that force a line into being AND step onto it. They are
    # asked here rather than above because the guard only calls one of them a
    # write when the line is already there: forcing a line that does not exist
    # yet makes one, and making one takes nothing away from anybody. The scratch
    # project stands on `ours`, so `ours` is a line that exists.
    for forced in ("git checkout -B ours x", "git switch -C ours x"):
        said = merge_says(forced, says=LIKE_IT, on="ours", board=True)
        assert "by hand" in said, \
            "%r rewrote the landing line without folding anything into it, " \
            "and was answered with %r" % (forced, said)
    assert merge_says("git checkout -B not-a-line-here x", says=LIKE_IT,
                      on="ours", board=True) == "", \
        "forcing a line that does not exist yet was refused, and making a " \
        "line of your own takes nothing away from anybody"

    print("ok: the line a project lands on cannot be pointed at a commit by hand, "
          "by any of the six spellings, nor taken away, and a push or a fetch "
          "onto it queues for the slot like a merge — while asking where the "
          "shell stands writes nowhere and is answered")

    # The second layer, and the one that answers for whatever the first never saw:
    # a hook inside the checkout itself, reading the ref write instead of the
    # command that made it (bw-7e8.5).
    GUARD = os.path.join(HOME, "hooks", "landing-gate.py")

    def by_the_checkout(cmd, holder=""):
        """What the checkout's own guard does to one command line: everything git
        said, and whether the landing line actually moved.

        A throwaway project that lands on `ours`, with the real hook wired into
        both directories this project's git looks in — the top of the working
        tree for an ordinary command, and the git directory for anything arriving
        over a push, which is a different place and the one a guard is most easily
        left out of. The board is a stand-in on the path: these cases are about
        the guard, and asking the real one would take the merge slot away from a
        session that is using it.
        """
        tmp = tempfile.mkdtemp(prefix="board-landing-")
        try:
            where = os.path.join(tmp, "bin")
            os.makedirs(where)
            with open(os.path.join(where, "bd"), "w") as fh:
                fh.write('#!/usr/bin/env sh\necho \'{"holder": %s}\'\n'
                         % json.dumps(holder or None))
            os.chmod(os.path.join(where, "bd"), 0o755)
            env = dict(os.environ,
                       PATH=where + os.pathsep + os.environ.get("PATH", ""))

            def g(*args):
                return subprocess.run(["git"] + list(args), cwd=tmp, text=True,
                                      capture_output=True, timeout=120, env=env)

            g("init", "-q", "-b", "ours", ".")
            g("config", "user.email", "t@t")
            g("config", "user.name", "t")
            g("config", "receive.denyCurrentBranch", "updateInstead")
            g("config", "core.hooksPath", ".beads/hooks")
            g("commit", "-q", "--allow-empty", "-m", "the line as it stands")
            g("commit", "-q", "--allow-empty", "-m", "a piece of work, finished")
            g("branch", "work")
            # Put the line back behind the work, while there is still no guard to
            # mind: what every case below starts from is a landing waiting to
            # happen.
            g("update-ref", "refs/heads/ours", "HEAD~1")
            g("reset", "-q", "--hard", "ours")
            with open(os.path.join(tmp, project.DECLARATION), "w") as fh:
                fh.write('name = "landing"\nprefix = "lnd"\nlands_on = "ours"\n'
                         'agent_merges = true\n')
            shim = "#!/usr/bin/env sh\nexec %s %s \"$@\"\n" % (sys.executable, GUARD)
            for hooks in (os.path.join(tmp, ".beads", "hooks"),
                          os.path.join(tmp, ".git", ".beads", "hooks")):
                os.makedirs(hooks, exist_ok=True)
                with open(os.path.join(hooks, "reference-transaction"), "w") as fh:
                    fh.write(shim)
                os.chmod(os.path.join(hooks, "reference-transaction"), 0o755)
            was = g("rev-parse", "ours").stdout.strip()
            run = subprocess.run(cmd, cwd=tmp, shell=True, text=True,
                                 capture_output=True, timeout=120, env=env)
            return (run.stdout + run.stderr), g("rev-parse", "ours").stdout.strip() != was
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    said, moved = by_the_checkout("git update-ref refs/heads/ours work", holder="someone-1")
    assert not moved and "landing gate" in said, \
        "the line was moved by hand inside the checkout, while the slot was held, " \
        "and the guard said %r" % said
    said, moved = by_the_checkout("git symbolic-ref refs/heads/ours refs/heads/work")
    assert not moved and "landing gate" in said, \
        "the landing line was repointed at another line and the guard said %r" % said
    said, moved = by_the_checkout("git merge --ff-only work", holder="someone-1")
    assert moved, "a fast-forward landing was refused to the holder of the slot: %r" % said
    said, moved = by_the_checkout("git merge --ff-only work")
    assert not moved and "merge slot" in said, \
        "work was folded into the landing line with nobody holding the slot: %r" % said
    # The board's own ref. It is synced by bd on its own schedule, nothing here
    # can tell a legitimate one from any other, and a guard that stopped it would
    # stop the board.
    said, _ = by_the_checkout("git update-ref refs/dolt/data work "
                      "&& git rev-parse --verify refs/dolt/data")
    assert re.search(r"^[0-9a-f]{40}$", said.strip(), re.M), \
        "the guard reached a ref that is not the landing line: %r" % said
    # Tidying the checkout. `git stash` writes the landing line the sha it
    # already holds, on every stash — which is the whole reason the guard has a
    # case for a line standing still, and the one thing the litter sweep cannot
    # do without. It is told apart from a hand write by the old value: git passes
    # the real one for anything of its own and all-zeroes for an `update-ref`.
    said, moved = by_the_checkout(
        "echo litter > f.txt && git add f.txt && git stash push -q -m tidy "
        "&& git rev-parse --verify refs/stash")
    assert not moved and "landing gate" not in said, \
        "tidying the shared checkout with `git stash` was refused, which would " \
        "leave the litter sweep nothing to sweep with: %r" % said
    assert re.search(r"^[0-9a-f]{40}$", said.strip(), re.M), \
        "nothing was stashed, so the case above proved nothing: %r" % said
    said, moved = by_the_checkout("git update-ref refs/heads/ours ours")
    assert not moved and "landing gate" in said, \
        "the landing line was written by hand the sha it already holds — no move, " \
        "but no landing either — and the guard said %r" % said
    # The manager's own hand in the shared checkout. The slot queues folds, and a
    # commit is not one.
    said, moved = by_the_checkout('git commit -q --allow-empty -m "the manager\'s own"')
    assert moved and "landing gate" not in said, \
        "an ordinary commit on the landing line, with no slot held, was refused " \
        "inside the shared checkout: %r" % said
    # And the same move made by a hand instead of by a commit, which is what the
    # incident was: `git update-ref <line> <new> <old>`, handed the tip it moves
    # off, is reported to the hook exactly as a commit is, and <new> is built here
    # to carry the whole of the waiting work (bw-7e8.8).
    SQUASH = ('new=$(git commit-tree $(git rev-parse work^{tree}) '
              '-p $(git rev-parse ours) -m squashed) && '
              'git update-ref refs/heads/ours $new $(git rev-parse ours)')
    said, moved = by_the_checkout(SQUASH)
    assert not moved and "landing gate" in said, \
        "a whole squashed commit was walked onto the landing line by hand, with " \
        "no slot held and no landing of any kind, and the guard said %r" % said
    said, moved = by_the_checkout(SQUASH, holder="someone-1")
    assert moved, \
        "the same move with the slot held was refused as well, which leaves the " \
        "manager no way to put the line right by hand at all: %r" % said

    print("ok: inside the checkout, the landing line refuses a hand-moved pointer "
          "even where it would not have moved and even where it is dressed as a "
          "commit, refuses an unslotted fold, takes a slotted one, lets the "
          "checkout be tidied, and leaves every other ref — the board's own above "
          "all — alone")

    # And the guard being there at all, which is `join`'s job. Every case above
    # wires the hook by hand, so all of them stay green in a checkout that has no
    # guard in it — the one shape of this fault that matters most, because the
    # directory the guard lives in is the board tooling's own and gets rebuilt
    # (bw-7e8.7).
    def joined(wipe=False):
        """A throwaway project put through the real `join`, and what its git then
        does to the landing line moved by hand.

        The machinery is a throwaway too — the three files this piece needs and
        nothing else — so joining lists a project in a temporary register and has
        no definitions of a machine home to link anywhere.
        """
        tmp = tempfile.mkdtemp(prefix="board-join-")
        try:
            mine = os.path.join(tmp, "machinery")
            os.makedirs(os.path.join(mine, "hooks"))
            for near in ("join", "project.py",
                         os.path.join("hooks", "landing-gate.py")):
                shutil.copy(os.path.join(HOME, near), os.path.join(mine, near))
            root = os.path.join(tmp, "project")
            os.makedirs(root)
            env = dict(os.environ, HOME=tmp)

            def g(*args):
                return subprocess.run(["git"] + list(args), cwd=root, text=True,
                                      capture_output=True, timeout=120, env=env)

            g("init", "-q", "-b", "ours", ".")
            g("config", "user.email", "t@t")
            g("config", "user.name", "t")
            # Relative on purpose: it is what `bd hooks install` writes, and it
            # is the spelling that sends git looking in two different places.
            g("config", "core.hooksPath", ".beads/hooks")
            g("commit", "-q", "--allow-empty", "-m", "the line as it stands")
            g("commit", "-q", "--allow-empty", "-m", "a piece of work, finished")
            with open(os.path.join(root, project.DECLARATION), "w") as fh:
                fh.write('name = "joining"\nprefix = "jn"\nlands_on = "ours"\n'
                         'areas = ["tooling"]\nagent_merges = true\n')
            said = subprocess.run([sys.executable, os.path.join(mine, "join"), root],
                                  text=True, capture_output=True, timeout=120, env=env)
            gitdir = g("rev-parse", "--absolute-git-dir").stdout.strip()
            wrote = [w for w in
                     (os.path.join(root, ".beads", "hooks", "reference-transaction"),
                      os.path.join(gitdir, ".beads", "hooks", "reference-transaction"))
                     if os.path.exists(w)]
            if wipe:
                # The board's own tooling rebuilding its hooks directory, which
                # is how a joined checkout loses the guard without anybody
                # touching it.
                shutil.rmtree(os.path.join(root, ".beads", "hooks"))
            was = g("rev-parse", "ours").stdout.strip()
            hand = g("update-ref", "refs/heads/ours", "HEAD~1")
            moved = g("rev-parse", "ours").stdout.strip() != was
            check = subprocess.run(
                [sys.executable, os.path.join(mine, "join"), "--check"],
                text=True, capture_output=True, timeout=120, env=env)
            return (said.stdout + said.stderr, wrote, hand.stdout + hand.stderr,
                    moved, check.stdout + check.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    said, wrote, hand, moved, check = joined()
    assert len(wrote) == 2, \
        "joining a project left the guard at %s — git looks in the top of the " \
        "working tree for an ordinary command and in the git directory for " \
        "anything arriving over a push, and a guard in only one of them is a " \
        "guard a push walks past. join said %r" % (wrote or "neither place", said)
    assert not moved and "landing gate" in hand, \
        "a project that has just been joined let its landing line be moved by " \
        "hand: %r (join said %r)" % (hand, said)
    assert "nothing guards the landing line" not in check, \
        "join wrote the guard and then reported it missing: %r" % check

    said, wrote, hand, moved, check = joined(wipe=True)
    assert moved, \
        "the landing line held still with no guard in the working tree's hooks " \
        "directory, so the case above proves nothing about the guard: %r" % hand
    assert "nothing guards the landing line" in check, \
        "a checkout whose board tooling rebuilt its hooks directory runs " \
        "unguarded and `join --check` says nothing about it: %r" % check

    print("ok: joining a project leaves the landing guard in both places git "
          "looks for a hook, a joined checkout turns away a hand-moved pointer "
          "without anything wiring it by hand, and a checkout that lost the "
          "guard to its own board tooling is told so")

    # Litter in the checkout a landing lands in. Left to git, any tracked change
    # there refuses the landing with "Working directory has staged changes" and
    # names nobody (bw-vb2.3), so the gate looks first: leftovers nobody live is
    # holding go into a labelled stash and the landing carries on, and leftovers
    # somebody live is holding refuse it by name (bw-vb2).
    def landing_in(litter, live=(), dead=(), cmd="git merge --ff-only work",
                   line_elsewhere=False):
        """What the gate tells a landing with these leftovers in its way, and what
        the checkout looks like after.

        A real checkout, real leftovers, and real session records of the shape
        `hooks/board-touch.py` writes — the gate reads all three off the disk and
        none of them can be faked in memory. `live` and `dead` are (session id,
        card id, board name, [paths]); a dead one has its record and its file
        both dated past the lease, which is the whole of what tells them apart.

        `line_elsewhere` puts the landing line in a worktree of its own and
        stands the main checkout on something else, with the command typed in the
        main checkout — which is how work lands here: a session pushes from one
        tree and git applies it to whichever tree holds the line. Then the tree
        the landing lands in is neither the project's root nor the tree the
        command was typed in, and a gate that read either of those would find a
        spotless checkout and sweep nothing.
        """
        tmp = tempfile.mkdtemp(prefix="board-litter-")
        try:
            root = os.path.join(tmp, "shared")
            state = os.path.join(tmp, "state", "board-sessions")
            os.makedirs(root)
            os.makedirs(state)
            where = os.path.join(tmp, "bin")
            os.makedirs(where)
            # The board, standing in for the real one: these cases are about the
            # leftovers, and asking the real board would take the merge slot away
            # from a session using it.
            with open(os.path.join(where, "bd"), "w") as fh:
                fh.write(BOARD % json.dumps(
                    [{"id": cid, "assignee": name}
                     for _, cid, name, _ in list(live) + list(dead)]))
            os.chmod(os.path.join(where, "bd"), 0o755)
            env = dict(os.environ,
                       PATH=where + os.pathsep + os.environ.get("PATH", ""),
                       CLAUDE_CODE_TMPDIR=os.path.join(tmp, "state"))

            def g(*args):
                return subprocess.run(["git"] + list(args), cwd=root, text=True,
                                      capture_output=True, timeout=120, env=env)

            def gl(*args):  # the same, in the tree the landing lands in
                return subprocess.run(["git"] + list(args), cwd=land, text=True,
                                      capture_output=True, timeout=120, env=env)

            g("init", "-q", "-b", "ours", ".")
            g("config", "user.email", "t@t")
            g("config", "user.name", "t")
            os.makedirs(os.path.join(root, ".beads"))
            with open(os.path.join(root, project.DECLARATION), "w") as fh:
                fh.write('name = "litter"\nprefix = "lit"\nlands_on = "ours"\n'
                         'agent_merges = true\n')
            for name in sorted(set(litter) | {"untouched.txt"}):
                with open(os.path.join(root, name), "w") as fh:
                    fh.write("as it was\n")
            g("add", "-A")
            g("commit", "-q", "-m", "the line as it stands")
            g("branch", "work")
            g("checkout", "-q", "work")
            with open(os.path.join(root, "untouched.txt"), "w") as fh:
                fh.write("the work\n")
            g("commit", "-qam", "a piece of work, finished")
            g("checkout", "-q", "ours")
            land = root
            if line_elsewhere:
                g("branch", "parked")
                g("checkout", "-q", "parked")
                land = os.path.join(tmp, "landing")
                g("worktree", "add", "-q", land, "ours")
            # An untracked file, which blocks no landing and must survive a sweep.
            with open(os.path.join(land, "not-git's.txt"), "w") as fh:
                fh.write("nobody's\n")
            for name in litter:
                with open(os.path.join(land, name), "w") as fh:
                    fh.write("half-done\n")
                gl("add", name)
            now = time.time()
            # Several entries naming one session are several claims of that one
            # session, oldest first: a session keeps one record however many cards
            # it holds, and a file written per entry would leave only the last.
            records = {}
            for sid, cid, _, paths in list(live) + list(dead):
                gone = (sid, cid) in [(s, c) for s, c, _, _ in dead]
                when = now - (LONG_GONE if gone else 5)
                rec = records.setdefault(sid, {"last_beat": when, "claims": [],
                                               "edits": []})
                rec["last_beat"] = when
                rec["claims"].append({"id": cid, "t": when})
                rec["edits"] += [{"p": os.path.join(land, x), "t": when}
                                 for x in paths]
            for sid, rec in records.items():
                full = os.path.join(state, sid + ".json")
                with open(full, "w") as fh:
                    json.dump(rec, fh)
                os.utime(full, (rec["last_beat"], rec["last_beat"]))
            said = subprocess.run(
                [sys.executable, MERGE_GATE], input=json.dumps({
                    "tool_name": "Bash", "tool_input": {"command": cmd},
                    "cwd": root, "session_id": LANDER}),
                capture_output=True, text=True, timeout=120, env=env).stdout.strip()
            out = json.loads(said) if said else {}
            spoke = (out.get("hookSpecificOutput", {}).get("permissionDecisionReason")
                     or out.get("systemMessage") or "")
            refused = (out.get("hookSpecificOutput", {}).get("permissionDecision")
                       == "deny")
            return {
                "said": spoke,
                "refused": refused,
                "read": out.get("hookSpecificOutput", {}).get("additionalContext", ""),
                "dirty": [r[3:] for r in
                          gl("status", "--porcelain", "-uno").stdout.splitlines()],
                "stashes": gl("stash", "list").stdout.strip(),
                "kept": os.path.exists(os.path.join(land, "not-git's.txt")),
            }
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # Leftovers nobody is holding: swept, and the landing goes through.
    got = landing_in(["stale.txt", "also-stale.txt"],
                     dead=[(DEAD_SID, "lit-9.1", "main-deadbeef",
                            ["stale.txt", "also-stale.txt"])])
    assert not got["refused"], \
        "a landing was refused for leftovers whose session finished and went: %r" \
        % got["said"]
    assert not got["dirty"], \
        "the checkout still has %r in it, so the landing is still blocked by " \
        "exactly what the sweep was for" % got["dirty"]
    assert "the landing gate swept these aside" in got["stashes"], \
        "the leftovers were not set aside under a label saying who set them " \
        "aside: %r" % got["stashes"]
    assert re.search(r"\d{4}-\d\d-\d\d", got["stashes"]), \
        "the label carries no date, so a checkout with several of them says " \
        "nothing about which is which: %r" % got["stashes"]
    for name in ("stale.txt", "also-stale.txt"):
        assert name in got["said"] and name in got["read"], \
            "the note does not name %s, so the session cannot find its own work " \
            "again: %r" % (name, got["said"])
    assert got["kept"], \
        "the sweep moved an untracked file, which blocks no landing at all and " \
        "is the one thing a stash of it is hardest to get back"

    # A file nobody's record mentions at all — the session died before anything
    # was written down, or the record aged out. Nobody live is holding it.
    got = landing_in(["nameless.txt"])
    assert not got["refused"] and not got["dirty"], \
        "a leftover no session record mentions blocked the landing: %r" % got["said"]

    # And the same leftovers with their session still at work.
    got = landing_in(["theirs.txt", "stale.txt"],
                     live=[(LIVE_SID, "lit-9.2", "bw-vb2-11112222", ["theirs.txt"])],
                     dead=[(DEAD_SID, "lit-9.1", "main-deadbeef", ["stale.txt"])])
    assert got["refused"], \
        "a landing walked over the half-done work of a session still at it: %r" \
        % got["said"]
    assert "bw-vb2-11112222" in got["said"], \
        "the refusal names nobody, which is the whole fault it was built for: %r" \
        % got["said"]
    assert "theirs.txt" in got["said"], \
        "the refusal names the session but not the file it is waiting on: %r" \
        % got["said"]
    assert got["said"].count("bw-vb2-11112222") >= 2, \
        "the refusal names the session once — beside the file or at the head of " \
        "it, but not both — and a refusal read in a hurry is read at the head: " \
        "%r" % got["said"]
    assert "stale.txt" not in got["said"], \
        "the refusal blames the live session for a leftover that is not theirs, " \
        "which sends whoever reads it to the wrong person: %r" % got["said"]
    assert got["dirty"] and not got["stashes"], \
        "the refusal still swept the checkout, so a live session's work was " \
        "moved out from under it anyway: %r" % got["stashes"]

    # One session holding two cards, which is the ordinary way of working here:
    # it left these files in the checkout the landing lands in and then claimed
    # something from a tree of its own, inside the same lease. The refusal has to
    # call it by the tree the files are in; the name it holds elsewhere sends
    # whoever reads it to a checkout with nothing of the sort in it.
    got = landing_in(["theirs.txt"],
                     live=[(LIVE_SID, "lit-9.3", "main-" + LIVE_SID[:8],
                            ["theirs.txt"]),
                           (LIVE_SID, "lit-9.4", "bw-vb2-" + LIVE_SID[:8], [])])
    assert got["refused"], \
        "a landing walked over the half-done work of a session still at it: %r" \
        % got["said"]
    assert ("main-" + LIVE_SID[:8]) in got["said"], \
        "the refusal names the session by a tree it moved on to rather than by " \
        "the one its files are sitting in: %r" % got["said"]
    assert ("bw-vb2-" + LIVE_SID[:8]) not in got["said"], \
        "the refusal carries a name from another tree as well, so it reads as " \
        "two sessions where there is one: %r" % got["said"]

    # The push spelling, which is how work lands here and the strict one: every
    # tracked change blocks it, whether or not the landing goes near the file.
    got = landing_in(["stale.txt"],
                     dead=[(DEAD_SID, "lit-9.1", "main-deadbeef", ["stale.txt"])],
                     cmd="git push . work:ours")
    assert not got["refused"] and not got["dirty"], \
        "a landing spelled as a push was left blocked by leftovers nobody holds: " \
        "%r" % got["said"]

    # The line checked out somewhere else again: typed in the main checkout,
    # landing in a worktree that holds the line, which is how work lands here.
    # The checkout that gets looked at is the one holding the line — not the
    # project's root and not the tree the session is standing in, both of which
    # are spotless here.
    got = landing_in(["stale.txt"],
                     dead=[(DEAD_SID, "lit-9.1", "main-deadbeef", ["stale.txt"])],
                     cmd="git push . work:ours", line_elsewhere=True)
    assert not got["refused"] and not got["dirty"], \
        "a landing pushed from one tree left the leftovers sitting in the tree it " \
        "actually lands in: %r" % got["said"]
    assert "stale.txt" in got["said"], \
        "the note says nothing about the tree the landing lands in: %r" % got["said"]

    # A clean checkout is left alone: no stash, and nothing said.
    got = landing_in([])
    assert not got["refused"] and not got["stashes"] and not got["said"], \
        "a landing with nothing in its way was answered with %r" % got["said"]

    print("ok: a landing clears leftovers no live session holds into a stash "
          "labelled with the date and who swept them, says what it moved, leaves "
          "untracked files alone, and refuses by name when the leftovers belong "
          "to a session still at work — by the name that session carries in the "
          "checkout the files are sitting in, not the one it took elsewhere")

    # Which checkout a command belongs to. Some shells report the directory the
    # session was started in whatever directory the command names, so a command
    # that opens by moving into another registered checkout is taken at its word
    # — and the move itself is then not part of what the command says, because a
    # worktree named after its card would otherwise spell that card in every line
    # run inside it.
    import board_common as common

    registered = sorted(project.registry().values())
    elsewhere = next((p for p in registered if p != ROOT), None)

    def hopped(cmd, cwd=ROOT):
        data = {"cwd": cwd, "tool_input": {"command": cmd}}
        return common.where(data), common.said(data)

    # The two answers come off one reading of the command, because resolving the
    # named path reads the registry and runs git, and every Bash gate wants both.
    resolved = [0]
    was_root, project.root = project.root, lambda p=None, _r=project.root: (
        resolved.__setitem__(0, resolved[0] + 1) or _r(p))
    try:
        common._HOPPED.clear()
        hopped("cd %s && git status" % (elsewhere or ROOT))
    finally:
        project.root = was_root
    assert resolved[0] <= 1, \
        "the checkout a command runs in was worked out %d times for one command" % resolved[0]

    seen, rest = hopped("cd /nowhere-at-all && git status")
    assert seen == ROOT, "a path that is no checkout re-pointed the whole command"
    assert rest.startswith("cd "), "an unrecognised move was stripped anyway: %r" % rest

    # The rest of the rule needs a second checkout to move into. A machine with
    # one is a machine, not a failure: the case says so and stands aside.
    if not elsewhere:
        print("ok: a command that names no checkout keeps the session's own "
              "(only one checkout is registered here, so the rest of this case "
              "has nowhere to move to)")
    else:
        seen, rest = hopped("cd %s && git status" % elsewhere)
        assert seen == elsewhere, \
            "a command that moved into another checkout was judged against the session's own: %s" % seen
        assert "cd" not in rest.split("&&")[0], \
            "the move that got the command there is still part of what it says: %r" % rest

        seen, _ = hopped("ls && cd %s && git status" % elsewhere)
        assert seen == ROOT, \
            "a move buried behind another command was read as where the command runs"

        inside = os.path.join(elsewhere, "worktrees")
        if os.path.isdir(inside):
            seen, _ = hopped("cd %s && git status" % inside)
            assert common.board_root(seen) == common.board_root(inside), \
                "a tree inside another checkout answered to %s, not to that checkout" % seen

        # End to end through the gate this job was opened to fix: a commit made
        # in the other checkout, naming that project's own card.
        other_prefix = project.of(elsewhere).prefix
        commit = "git " + "commit -m "

        # In its own process, because this case is the only one that needs the
        # machine's real projects: the suite replaces the prefix pair with the
        # fixture's for every other case, and a commit judged against a fixture
        # prefix would prove nothing about the two checkouts in play here.
        def gate_says(cmd, cwd=ROOT):
            said = subprocess.run(
                [os.path.join(HOME, "hooks", "board-status-gate.py")],
                input=json.dumps({"session_id": "abcd1234", "cwd": cwd,
                                  "tool_input": {"command": cmd}}),
                capture_output=True, text=True).stdout
            return json.loads(said)["hookSpecificOutput"]["permissionDecisionReason"] \
                if said.strip() else ""

        said_it = gate_says("cd %s && %s'fix(x): %s-1a2b something'"
                            % (elsewhere, commit, other_prefix))
        assert said_it == "", \
            "a commit made in another checkout, naming that project's own card, was refused: %s" % said_it
        # A prefix no board on this machine issues, because either checkout may
        # declare that its change lands in the other, and then the two accept the
        # same ids and no real prefix says which one judged the commit. What is
        # left to read is the refusal: it names the checkout the commit is being
        # made in, so the same commit with nowhere to move to spells the answer
        # this case wants, and the bogus move must not shift it.
        bogus = "fix(x): zz-1a2b something"
        here = gate_says("%s'%s'" % (commit, bogus))
        judged = gate_says("cd /nowhere-at-all && %s'%s'" % (commit, bogus))
        assert "put one of those ids" in judged and judged == here \
            and elsewhere not in judged, \
            "a commit opening with a move to a directory that does not exist was not " \
            "judged against the session's own checkout: %s" % (judged or "it was allowed")
        assert gate_says("cd %s/worktrees && %s'chore: nothing named here'" % (elsewhere, commit)) != "", \
            "a commit naming no card at all was let through by the path it was run from"

        # The name a card is claimed under carries which copy the work is in,
        # and both checks for an abandoned copy read the copy off that name. A
        # session that reaches a copy by moving into it must be named for the
        # copy, or the teardown closes without ever looking.
        def stamped(cmd, cwd=ROOT):
            out = subprocess.run(
                [os.path.join(HOME, "hooks", "board-actor.py")],
                input=json.dumps({"session_id": "abcd1234", "cwd": cwd,
                                  "tool_input": {"command": cmd}}),
                capture_output=True, text=True).stdout
            if not out.strip():
                return cmd
            return json.loads(out)["hookSpecificOutput"]["updatedInput"]["command"]

        copy = os.path.join(elsewhere, "worktrees", "any-copy")
        os.makedirs(copy, exist_ok=True)
        said = stamped("cd %s && bd ready" % copy)
        assert "--actor any-copy-" in said, \
            "a command run inside a copy was stamped with the name of the tree it started in: %s" % said

        print("ok: a command is judged by the checkout it opens by moving into, an "
              "unrecognised path leaves it with the session's own, the move is never "
              "part of what the command says, the commit gate acts on all three, and "
              "the name a board command is made under carries the copy it runs in")

    # The three answers the cost report has about a counter, which have to stay
    # three. Read against a counter file of its own: the real one is the number the
    # manager reads, and a case that appends to it inflates what he is told.
    import cost
    tmp = tempfile.mkdtemp(prefix="board-cost-")
    was_rows, cost.COUNTERS = cost.COUNTERS, os.path.join(tmp, "counters.jsonl")
    try:
        cost.record("habit-cause")
        out = io.StringIO()
        keep, sys.stdout = sys.stdout, out
        try:
            cost.future_section()
        finally:
            sys.stdout = keep
        rows = {l.split()[0]: l for l in out.getvalue().splitlines()
                if l.startswith("  ")}
    finally:
        cost.COUNTERS = was_rows
        shutil.rmtree(tmp, ignore_errors=True)

    assert rows["habit-cause"].split()[1] == "1", \
        "a refusal that fired once was not reported as one firing: %s" \
        % rows["habit-cause"]
    assert "built, never fired" in rows["landing-gated"], \
        "a refusal that is on disk and has caught nobody reads as one nobody built, " \
        "so he cannot tell a quiet gate from a missing one: %s" % rows["landing-gated"]
    assert not cost.built("landing-gated", "docs/board.md"), \
        "the report calls a counter built without finding the line that records it"
    assert cost.unlisted() == {}, \
        "a hook records a counter the report describes in no row, so it is counted " \
        "and never reported: %s" % cost.unlisted()

    print("ok: the cost report tells a refusal nobody built from one built and never "
          "fired, reads which off the file that records it, and names a counter no "
          "row of its own describes")

    # The reader files its objections through the same pour, so the bars apply to
    # it too. Its own pour is replaced here: the board is never touched, and what
    # is under test is what the reader does when the pour says no.
    where = os.path.join(HOME, "board", "review")
    spec = importlib.util.spec_from_loader(
        "board_review", importlib.machinery.SourceFileLoader("board_review", where))
    reviewer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reviewer)

    class Refused:
        returncode, stdout, stderr = 1, "", "that title is written in builder's words"

    class Took:
        returncode, stderr = 0, ""
        stdout = "g.9\n"

    asked = []

    def pretend(args, **kw):
        asked.append(args)
        return Refused() if "builder" in " ".join(args) else Took()

    reviewer.subprocess.run = pretend
    reviewer.bd = lambda args, actor=None, must=True: ""
    made, turned = reviewer.file_findings(
        "g", [{"title": "the builder's own words", "where": "x", "why": "y",
               "fixed_when": "`cargo test` reports 0 failures"}])
    assert not made and len(turned) == 1 and "builder's words" in turned[0][1], \
        "a finding the board refused was dropped without a word: %r" % (turned,)

    asked = []
    reviewer.file_findings("g", [{"title": "the lamp is drawn twice", "where": "x",
                                  "why": "y", "fixed_when": "it works"}])
    filed = asked[0][asked[0].index("--do") + 1].split("|")[-1]
    assert not bars.finish_line(filed, "x"), \
        "the reader's fallback proof is one the board itself would refuse: %r" % filed

    print("ok: an objection the board turns away leaves the job shut instead of "
          "vanishing, and the reader's own fallback clears the bar it is held to")

    tmp = tempfile.mkdtemp(prefix="helper-proof-")
    try:
        edit_then_say = ["Edit"]
        assert "nothing ran" in helper_return(
            "Fixed the lamp. Verified: the highlight is back.",
            edit_then_say, where=tmp), \
            "a helper claiming it verified its own change, with nothing run after it, was believed"
        assert not helper_return(
            "Fixed the lamp. Verified: the highlight is back.",
            ["Edit", ("Bash", "cargo test")], where=tmp), \
            "a helper that ran something after its change was refused anyway"
        assert not helper_return(
            "Fixed the lamp; I could not verify it, no GPU on this box.",
            edit_then_say, where=tmp), \
            "a helper that said outright it did not verify was refused for not verifying"
        assert not helper_return("Changed the two call sites.", edit_then_say,
                                 where=tmp), \
            "a helper that claimed nothing was refused"

        dump = "\n".join("line %d of a pasted build log" % i for i in range(200))
        assert "transcript, not a verdict" in helper_return(dump, ["Edit"], where=tmp), \
            "a helper that changed files and pasted a log back was let through"
        assert not helper_return(dump, ["Read"], where=tmp), \
            "a search helper was held to the cap measured for helpers that change files"
        assert "transcript, not a verdict" in helper_return(
            dump + "\nx" * 25_000, ["Read"], where=tmp), \
            "a search helper's answer was allowed to be any length at all"

        worked = [("Bash", "bd update tst-9k.2 --claim"), "Edit", ("Bash", "cargo test")]
        assert "names no card" in helper_return(
            "Done, all tests pass.", worked, where=tmp), \
            "a helper that claimed a card handed back an answer naming no card"
        assert not helper_return("tst-9k.2 done, all tests pass.", worked, where=tmp), \
            "a helper that named the card it claimed was refused"

        sys.stdin = io.StringIO(json.dumps({"hook_event_name": "SubagentStop",
                                            "cwd": ROOT}))
        out = io.StringIO()
        keep, sys.stdout = sys.stdout, out
        try:
            proof.main()
        finally:
            sys.stdout = keep
        assert not out.getvalue().strip(), \
            "the gate refused a helper whose transcript it could not even find"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("ok: a helper is refused for claiming it verified with nothing run, for "
          "handing back a transcript instead of a verdict, and for working a card "
          "it never names — and passes silently otherwise")

    # One command closing several cards of a job reaches `fire` once per card, and
    # every reader it sends carries the same brief: on 15 Aug twelve of them went
    # out at one goal and spent the account's allowance between them (mch-m1t).
    # These stand on the claim, so they run against a real directory rather than a
    # recorder — nothing here touches a board.
    sent = storm()
    assert sent == 1, \
        "six cards of one job closed together sent %d readers, not one" % sent
    # A reader somebody started by hand is still a reader out on that job
    # (mch-m1t.15).
    by_hand = tempfile.mkdtemp()
    theirs = pretend_reader(by_hand, "g")
    try:
        inflight.clear("g")
        inflight.take("g")
        inflight.name("g", theirs.pid)
        assert storm(claimed=True) == 0, \
            "a job with a hand-started reader on it was sent another"
    finally:
        theirs.kill()
        theirs.wait()
        shutil.rmtree(by_hand, ignore_errors=True)
        inflight.clear("g")
    assert release_sends(signed=True, shas=["a1", "b2"]) == 1, \
        "a commit that landed under a reader was never read by anyone"
    assert release_sends(signed=True, shas=["a1"]) == 0, \
        "a job just read was sent another reader with nothing new to read"
    assert release_sends(signed=False, shas=["a1"]) == 0, \
        "a reader that never signed sent another at itself, which is the storm"
    # The reader's own three findings on this change (mch-m1t.9 and .11): a job
    # that counts its reader among the hands that wrote it, and a job this very
    # reading put work back into, are both jobs a reader could send its own
    # successor at for good.
    assert release_sends(signed=True, shas=["a1"], wrote=("someone", "review-g")) == 0, \
        "a job whose reader counts as one of its own writers sends readers for ever"
    assert release_sends(signed=True, shas=["a1", "b2"],
                         rows=CROWDED[:2] + [dict(r, status="open")
                                             for r in CROWDED[2:]]) == 0, \
        "a job with work open again was sent a reader anyway"
    # A clean reading opens the step after itself before it lets go, so the cards
    # a letting-go really sees include that one — the reader's own mch-m1t.12.
    assert release_sends(signed=True, shas=["a1", "b2"],
                         rows=CROWDED + [{"id": "g.9", "status": "open",
                                          "labels": ["step:record", "of:g"]}]) == 1, \
        "a change that landed under a reader was read by nobody once it finished"

    print("ok: six cards of one job closed by one command send one reader and not "
          "six, a change that landed under a reader is read when it lets go — even "
          "once the reading has opened the step after itself — and nobody follows a "
          "reader that answered nothing, a job that counts its own reader as a "
          "writer, or a job with work open again")

    spawned, read, said, named = hands_off(detached=False)
    assert len(spawned) == 1 and not read, \
        "a reading fired by hand did the reading in the caller's own shell, which " \
        "is the wait this job exists to end"
    cmd, env = spawned[0]
    assert cmd[0].endswith("review") and "g" in cmd and "--rerun" in cmd, \
        "the copy a hand-fired reading spawned was not this same reader, on this " \
        "same job, asked the same way"
    assert env.get(inflight.DETACHED) and env.get(inflight.RUN_DIR), \
        "the copy was not told it is the copy, so it hands off to a copy of itself " \
        "and the reading is never done by anyone"
    assert "run.log" in said, \
        "a hand-fired reading gave the shell back without saying where its run went"
    spawned, read, said, named = hands_off(detached=True)
    assert not spawned and read == ["g"], \
        "the copy handed the reading on instead of doing it, which is a reader that " \
        "never arrives"
    # The copy names the claim itself wherever it finds no claim to inherit, and a
    # name is only half of what a later firing needs: without the console beside
    # it, whoever fires next is told the job is being read and nothing more.
    assert named == COPY_LOG, \
        "the copy named the claim after itself and said nothing about where it " \
        "writes, so a firing that finds the job held has nowhere to point"
    # A goal read clean is not read again, however it is fired at: the reading
    # covers the job's commits and says so on the goal, so what decides is the
    # work and not the switch (bw-5e8.5).
    spawned, read, said, named = hands_off(detached=False, notes=SIGNED % "a1c0ffee")
    assert not spawned and not read, \
        "a goal already read, with nothing written under it since, was read again " \
        "from the top — the same commits at a fresh session's price"
    assert "current" in said, \
        "a firing that read nothing did not say the reading on the goal is current"
    spawned, read, said, named = hands_off(detached=False, notes=SIGNED % "a1c0ffee",
                                    shas=("a1c0ffee", "b2deadbe"))
    assert len(spawned) == 1, \
        "a commit written under a goal since it was read was left unread"
    # A reader that died signed nothing, so what stands on the job has been read
    # by nobody and is read again without any forcing at all.
    spawned, read, said, named = hands_off(detached=False, rerun=False)
    assert len(spawned) == 1, \
        "a job a dead reader left shut was never read again, because nothing but " \
        "the switch could ask for it"

    already = tempfile.mkdtemp()
    stood = pretend_reader(already, "g")
    try:
        spawned, read, said, named = hands_off(detached=False, busy=stood.pid)
    finally:
        stood.kill()
        stood.wait()
        shutil.rmtree(already, ignore_errors=True)
    assert not spawned and not read, \
        "a firing that found a reader already out on the job sent a second one, " \
        "which is the same reading done twice at the account's expense"
    assert BUSY_LOG in said, \
        "a firing that stood down did not say where the reading already going is " \
        "writing, so whoever asked has nowhere to look"

    told = fires_marked()
    assert told["env"].get(inflight.DETACHED) and inflight.RUN_DIR not in told["env"], \
        "the board's own firing sent a reader it had not marked, so that reader " \
        "hands off to another and writes its attempts into its sender's directory"
    assert told["env"].get(inflight.CONSOLE), \
        "the board's own firing did not tell the reader where its console goes, so " \
        "a reader that has to name its own claim can say nothing about where it writes"

    print("ok: a reading fired by hand hands itself to a marked copy and says where "
          "the run went, the marked copy reads rather than handing off again, a "
          "goal read clean is read again only once something is written under it, "
          "a firing that finds a reader already out stands down and points at it, "
          "and the board's own firing marks the reader it sends")

    pretend = tempfile.mkdtemp()
    victim = pretend_reader(pretend, HELD)
    try:
        inflight.clear(HELD)
        inflight.take(HELD)
        inflight.name(HELD, victim.pid)
        assert not inflight.take(HELD), "a job was sent a second reader while one was out"
        # A reader is out for as long as its attempts take, so age alone must not
        # unseat it — the reader's own finding, mch-m1t.10.
        old = datetime.datetime.now().timestamp() - inflight.ATTEMPT_TIMEOUT * 4
        os.utime(inflight.where(HELD), (old, old))
        assert inflight.held(HELD), \
            "a reader still working was declared dead and its job sent another"
        os.utime(inflight.where(HELD), None)
        victim.kill()
        victim.wait()
        assert inflight.take(HELD), \
            "a reader that died held its job shut, so nobody could ever read it"
        # A claim carries its owner from the instant it is taken, so age alone
        # cannot unseat one whose owner is still at work: a firing a minute later
        # used to read it as abandoned, clear it, and put a second reader on the
        # same job (bw-5e8.4).
        inflight.clear(HELD)
        inflight.take(HELD)
        young = datetime.datetime.now().timestamp() - inflight.UNNAMED_GRACE - 10
        os.utime(inflight.where(HELD), (young, young))
        assert inflight.held(HELD), \
            "a claim seventy seconds old whose owner was still working was read as " \
            "one nobody was behind"
        assert not inflight.take(HELD), \
            "a second firing seventy seconds later took a claim that was held, " \
            "which is one job read twice over"
        # What makes such a claim stale is the owner going away, not the clock.
        # The number written below belonged to a process that has been reaped.
        with open(os.path.join(inflight.where(HELD), "owner"), "w") as fh:
            fh.write(str(victim.pid))
        assert not inflight.held(HELD), \
            "a claim whose owner died before it could spawn a reader held the job " \
            "for good"
        # A number is not a name: the owner is the process that took the claim,
        # not whoever holds its number afterwards. The owner below is written
        # with a birth that is not this process's, which is what a claim looks
        # like once its owner has died and the number has gone round again — and
        # what used to hold the job shut for good, since the number answers and
        # no clock is left watching it (bw-5e8.7).
        inflight.clear(HELD)
        inflight.take(HELD)
        with open(os.path.join(inflight.where(HELD), "owner"), "w") as fh:
            fh.write("%d %d" % (os.getpid(), inflight._born(os.getpid()) + 1))
        assert not inflight.held(HELD), \
            "a claim whose owner's number had been handed to another process " \
            "held the job shut for good, with no clock left to get it back"
        # A claim from before any of this carries no mark at all, and its age is
        # then the only thing there is to judge it by.
        inflight.clear(HELD)
        inflight.take(HELD)
        os.unlink(os.path.join(inflight.where(HELD), "owner"))
        os.utime(inflight.where(HELD), (young, young))
        assert not inflight.held(HELD), \
            "an unmarked claim older than the grace held the job for good"
        inflight.clear(HELD)
        inflight.take(HELD)
        inflight.name(HELD, os.getpid())
        assert not inflight.held(HELD), \
            "a claim naming a process that is alive but is not this job's reader " \
            "held the job shut, which is how a reused number locks a card"
        # Yes means the claim is held, every way round: a job answered as claimed
        # with nothing taken is a whole reading unguarded (mch-m1t.16).
        inflight.clear(HELD)
        keep_home, inflight.home = inflight.home, lambda: "/proc/nowhere"
        try:
            assert not inflight.take(HELD), \
                "a job was answered as claimed when no claim could be taken"
        finally:
            inflight.home = keep_home
    finally:
        if victim.poll() is None:
            victim.kill()
            victim.wait()
        inflight.clear(HELD)
        shutil.rmtree(pretend, ignore_errors=True)

    print("ok: a reader still running holds its job however long it takes, a claim "
          "whose owner is still at work holds it a minute after it was taken, and "
          "a claim left by a reader that died, by an owner that died, by an owner "
          "whose number has gone round to somebody else, by nobody at all, or "
          "naming somebody else's process does not")

    # What a commit costs. The machinery's own commit hook used to put all
    # ninety-odd faults back whenever a gate file was staged — minutes, paid
    # again on every commit of a change nobody had finished making. The checks
    # step is where that is paid now: once a job, in front of the reader, and
    # the command is the project's own to name (bw-a6o.2).
    hook_here = os.path.join(HOME, ".beads", "hooks", "pre-commit")
    runs = [l.strip() for l in open(hook_here).read().splitlines()
            if not l.lstrip().startswith("#")
            and re.search(r"/check\b|inject\.py|selftest\.py", l)]
    assert not runs, \
        "the machinery's commit hook runs its own suite or its fault put-back " \
        "again, so every commit to a gate pays minutes for a change nobody has " \
        "finished making: %s" % runs
    # The file this tree holds, not whatever `project.of` walks up to: a suite
    # run from a worktree would otherwise judge the main checkout's declaration.
    here = project.Declaration(HOME, project._read(os.path.join(HOME,
                                                               project.DECLARATION)))
    assert here.checks, \
        "the machinery declares no checks command, so the one step that is meant " \
        "to run its suite has nothing to run"
    assert re.search(r"^checks\s*=", open(os.path.join(HOME, "machinery.toml.example"))
                     .read(), re.M), \
        "the declaration every joining project copies never mentions the command " \
        "its checks step runs"
    assert project.Declaration("/nowhere", {}).checks == "", \
        "a project that declares no checks command cannot be read at all, so the " \
        "step refuses to open rather than saying what was run by hand"

    print("ok: the machinery's commit hook no longer runs its suite or its fault "
          "put-back, and a project names the command its checks step runs")

    # The suite under its own way out — the one thing the cases above cannot say
    # about themselves, and what the manager was handed as the escape. Last, so a
    # case that is red anyway says so in its own words before this reruns it.
    if CHILD not in sys.argv:
        for what, by_file in (("the variable", False), ("the file", True)):
            code, tail = suite_with_switch(by_file)
            assert code == 0, \
                "the whole suite goes red when the habit gate is switched off by %s, " \
                "so its own way out breaks the check that guards the board: %s" \
                % (what, tail)

        print("ok: the whole suite is green with the habit gate switched off, by the "
              "variable and by the file")


if __name__ == "__main__":
    main()
