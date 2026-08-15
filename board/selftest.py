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

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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


def run(goal_status, rows=None, notes="", shas=("a1c0ffee", "b2deadbe"),
        wrote=("someone",)):
    """The commands the hook issues when g.3, the last work item, closes."""
    goal = dict(GOAL, status=goal_status, notes=notes)
    rows = ROWS if rows is None else rows
    issued = []

    def recorder(args, root=None):
        issued.append(" ".join(args))
        if args[:2] == ["list", "--parent"]:
            return True, json.dumps(rows)
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
        ran = subprocess.run([sys.executable, os.path.abspath(__file__), CHILD],
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

    # A bug job that runs no guard step, closing the FIRST step of its order. The
    # words on the goal are the whole of the case: the same job is refused or let
    # through on nothing else. `poured` before ASKED_FROM is a job from before the
    # pour asked, which has no answer to give and is not held to one.
    AGENT_SAID = "the case suite already carries the assertion that goes red"
    HIS_WORDS = 'he approved dropping it: "that one is a throwaway, no guard"'

    def guarded(why, kind="bug", poured="2026-08-14T07:00:00Z"):
        """What the gate says to the opening step of such a job, and what it counted."""
        meta = {"spine": "worktree,clarify,prove,design,work,verify,review,record,land",
                "area": "board", "kind": kind}
        if why is not None:
            meta["skip.test"] = why
        goal = {"id": "tst-bug", "issue_type": "epic", "status": "in_progress",
                "created_at": poured, "metadata": meta,
                "labels": ["job", "area:board", "kind:" + kind]}
        # `job` on a step is not a mistake in the fixture: creating with `--parent`
        # copies the goal's labels down, and a step is only stripped of them once
        # `spine.settle` has run. Read that label first and the step answers as its
        # own goal, which carries no order and so answers for nothing.
        step = {"id": "tst-bug.1", "issue_type": "task", "status": "in_progress",
                "notes": "", "labels": ["step:worktree", "of:tst-bug", "job",
                                        "area:board", "kind:" + kind]}
        # The manager's count of what this gate costs, kept out of the real file:
        # a case that leaves rows behind inflates the number he is reading.
        fired, was = [], status.tally
        status.tally = fired.append
        try:
            said = refusal('bd close tst-bug.1 --reason="the tree is cut"', step,
                           {"tst-bug": goal, "tst-bug.1": step})
        finally:
            status.tally = was
        return said, fired

    said, fired = guarded(AGENT_SAID)
    assert "dropped the Guard step" in said and AGENT_SAID in said, \
        "a bug job waived its own guard step and was allowed to start: %s" \
        % (said or "ALLOWED")
    assert fired == ["guard-waiver"], \
        "the refusal fired without counting, so the manager's number stays a " \
        "guess: %s" % fired
    route = [l.strip() for l in said.splitlines() if l.strip().startswith("bd update")]
    assert route and route[0] == "bd update tst-bug --set-metadata spine=worktree," \
                                "clarify,prove,design,work,verify,test,review,record," \
                                "land", \
        "the way out puts the guard somewhere other than its own place: %s" % route

    kept, _ = guarded(HIS_WORDS)
    assert "dropped the Guard step" not in kept, \
        "the same job was refused with the manager's own yes on the goal: %s" % kept

    # What the check does is read the words a yes is given in, whoever typed them
    # (cor-abv8) — so a waiver the agent wrote for itself in those words passes, and
    # the refusal is held to promising no more than that.
    mine, _ = guarded("approved: I decided myself that the suite covers this one")
    assert "dropped the Guard step" not in mine, \
        "the case is written against words the check refuses anyway, so it says " \
        "nothing about what the refusal may claim: %s" % mine
    assert "not who typed them" in said and "cannot tell a claimed yes" in said, \
        "the refusal does not say what the check cannot catch: %s" % said
    assert "will not pass" not in said, \
        "the refusal promises the agent's own reasoning is stopped, and reading the " \
        "words does not stop it: %s" % said

    # The population this must not touch: a job whose fault is not a bug.
    spared, counted_it = guarded(why=AGENT_SAID, kind="chore")
    assert "dropped the Guard step" not in spared and not counted_it, \
        "a chore was held to the guard rule anyway: %s" % spared

    # And the one a project may declare out of it: the jobs it had already poured
    # when its pour began asking. A project that declared no such date has none —
    # which is what joining after the question existed means — so the case is the
    # other way round for it, and the rule reaching back to the board's first day
    # is the thing being held.
    OLD = "2000-01-01T00:00:00Z"
    old, counted_old = guarded(why=None, poured=OLD)
    if DECL.guard_asked_from:
        assert "dropped the Guard step" not in old and not counted_old, \
            "a job poured before this project's pour asked was held to the guard " \
            "rule anyway: %s" % old
    else:
        assert "dropped the Guard step" in old, \
            "this project declared no date its pour began asking, so every job it " \
            "has is held to the guard rule — and an old one was let through: %s" % old

    print("ok: a bug job cannot start while the only thing standing where its guard "
          "should be is the agent's own reasoning, the words of a yes are what let it "
          "through, and the refusal promises no more than reading words can do")

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
    assert "built, never fired" in rows["guard-waiver"], \
        "a refusal that is on disk and has caught nobody reads as one nobody built, " \
        "so he cannot tell a quiet gate from a missing one: %s" % rows["guard-waiver"]
    assert not cost.built("guard-waiver", "docs/board.md"), \
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
