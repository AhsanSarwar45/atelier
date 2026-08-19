#!/usr/bin/env python3
"""Fault injection on the report gates — each rule must go red on its own fault.

    report check
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board as board_mod  # noqa: E402
import build  # noqa: E402
from blocks import ReportError  # noqa: E402

GOOD = {
    "title": "Mirror Blur Fix",
    "actions": {
        "questions": [{
            "ask": "Ship the sharper mirrors, or hold for the wider road test?",
            "options": [{"label": "Ship", "say": "Ship the sharper mirrors.", "pick": True},
                        {"label": "Hold", "say": "Hold the mirrors."}],
            "note": "One day of work either way",
            "holds": "x.2",
        }],
    },
    "status": {
        "now": "Waiting on your answer above.",
        "next_up": "The wider road test starts the moment you say ship.",
        "items": [{"state": "done", "text": "Measured the old mirrors"},
                  {"state": "todo", "text": "Drive the long circuit"}],
    },
    "content": [{
        "label": "What changed",
        "blocks": [
            {"kind": "table",
             "columns": ["Where", {"name": "Sharpness", "align": "num"}],
             "rows": [["Left mirror", {"num": "2.4"}], ["Right mirror", {"num": "2.6"}]]},
            {"kind": "note", "tone": "good", "label": "Result", "text": "Both mirrors read clearly at speed."},
        ],
    }],
    "decisions": [
        {"id": "D1", "title": "Mirrors stay sharp at every distance", "why": "The driver looks at them briefly."},
        {"id": "D2", "title": "The long circuit is the test we trust"},
    ],
    "next": {
        "if_nothing": "The old blurry mirrors stay.",
        "steps": [{"step": "Drive the long circuit", "cost": "small", "starting": True}],
    },
}

CASES: list[tuple[str, object, str, str]] = []


def case(name: str, mutate, expect: str, kind: str = "error") -> None:
    """kind: 'error' stops the page, 'warn' only names the problem, '' is clean."""
    CASES.append((name, mutate, expect, kind))


def drop_slot(s):
    del s["status"]


def long_title(s):
    s["title"] = "A Very Long Title That Runs On And On"


def points_at_decision(s):
    s["actions"]["questions"][0]["ask"] = "Do you agree with D2 about the circuit?"


def one_option(s):
    s["actions"]["questions"][0]["options"] = [{"label": "Ship", "pick": True}]


def no_pick(s):
    for o in s["actions"]["questions"][0]["options"]:
        o.pop("pick", None)


def no_card_held(s):
    s["actions"]["questions"][0].pop("holds", None)


def bad_state(s):
    s["status"]["items"][0]["state"] = "nearly"


def no_next_up(s):
    del s["status"]["next_up"]


def duplicate_id(s):
    s["decisions"][1]["id"] = "D1"


def out_of_order(s):
    s["decisions"][0]["id"], s["decisions"][1]["id"] = "D2", "D1"


def jargon_word(s):
    s["content"][0]["blocks"][1]["text"] = "The mirror shader now samples fewer texels."


def markup_in_text(s):
    s["content"][0]["blocks"][1]["text"] = "Both mirrors read <b>clearly</b> at speed."


def colour_in_text(s):
    s["content"][0]["label"] = "Now #FF8800 across the glass"


def no_cost(s):
    del s["next"]["steps"][0]["cost"]


def too_many_glosses(s):
    s["glossary"] = [{"term": f"word{i}", "plain": "plain"} for i in range(7)]


def card_and_typed_status(s):
    s["status"]["card"] = "xx-1"


def reads_board(s):
    s["status"] = {"card": "xx-1"}


def board_and_typed_count(s):
    reads_board(s)
    s["eyebrow"] = "Three of five steps in"


def board_and_typed_step_list(s):
    reads_board(s)
    s["content"].append({
        "label": "The work, in order",
        "blocks": [{"kind": "rows", "rows": [{"n": "1", "title": "Measure", "note": "First."}]}],
    })


def board_and_a_measured_count(s):
    """A number that counts something real, and a section merely about the plan."""
    reads_board(s)
    s["content"][0]["blocks"][1]["text"] = "48 of 166 corners now read clearly."
    s["content"].append({
        "label": "What the plan was wrong about",
        "blocks": [{"kind": "note", "tone": "warn", "text": "The near corners were never the problem."}],
    })


case("a complete report builds", None, "", "")
case("a missing slot", drop_slot, "slot 'status' is missing")
case("a title that is a sentence", long_title, "title is")
case("a question pointing at a decision number", points_at_decision, "points at D2")
case("a question with one answer", one_option, "at least two answers")
case("a question holding up nothing", no_card_held, "names no card it is holding up")
case("a question with no recommendation", no_pick, "exactly one recommended")
case("an invented checklist state", bad_state, "state done, draft or todo")
case("no next-up named", no_next_up, "next_up")
case("two decisions sharing a number", duplicate_id, "share a number")
case("decision numbers going backwards", out_of_order, "out of order")
case("jargon in the content warns but still builds", jargon_word, "shader", "warn")
case("markup in the content", markup_in_text, "an HTML tag")
case("a colour in the content", colour_in_text, "a colour")
case("a step with no cost", no_cost, "needs a cost")
case("more than six glossed terms", too_many_glosses, "six is the ceiling")
case("a status both read from the board and typed", card_and_typed_status, "the board owns all three")
case("a report that reads a card and counts its steps too", board_and_typed_count, "counts the work itself")
case("a report that reads a card and lists its steps too", board_and_typed_step_list, "sets out the work in order")
case("a measured count and a section about the plan are allowed", board_and_a_measured_count, "", "")


def run() -> int:
    failures = []
    tmp = Path(tempfile.mkdtemp())
    spec_path = tmp / "case.report.json"
    build.previous = lambda _p: None
    # Every question names a card, so every build here asks the board about one.
    # The cases that are not about that rule get a board that says "still open".
    build.card_state = lambda card, project, base=None: "open"

    for name, mutate, expect, kind in CASES:
        spec = copy.deepcopy(GOOD)
        if mutate:
            mutate(spec)
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        problems, warnings = build.validate(spec, spec_path)
        looked_at = warnings if kind == "warn" else problems
        joined = " | ".join(looked_at)
        if expect and expect not in joined:
            failures.append(f"{name}: expected {expect!r}, got {joined or 'no complaint'}")
        if kind == "warn" and problems:
            failures.append(f"{name}: warned AND refused — a plain-words hit must not stop the page")
        if not expect and (problems or warnings):
            failures.append(f"{name}: a clean report was refused — {joined}")

    # an unknown block kind names the shelf instead of guessing
    spec = copy.deepcopy(GOOD)
    spec["content"][0]["blocks"] = [{"kind": "sankey"}]
    try:
        build.build(spec, build.Ctx([], tmp))
        failures.append("an unknown block: built anyway")
    except ReportError as e:
        if "sankey" not in str(e):
            failures.append(f"an unknown block: unhelpful complaint — {e}")

    # a table whose rows do not match its header
    spec = copy.deepcopy(GOOD)
    spec["content"][0]["blocks"][0]["rows"] = [["only one cell"]]
    try:
        build.build(spec, build.Ctx([], tmp))
        failures.append("a ragged table: built anyway")
    except ReportError:
        pass

    # a glossed term is allowed through, and reaches the page explained
    spec = copy.deepcopy(GOOD)
    spec["glossary"] = [{"term": "shader", "plain": "the code that colours a surface"}]
    spec["content"][0]["blocks"][1]["text"] = "The shader is unchanged."
    errs, warns = build.validate(spec, spec_path)
    if errs or warns:
        failures.append("a glossed term was still flagged")
    else:
        page = build.build(spec, build.Ctx(spec["glossary"], tmp))
        if 'class="gloss"' not in page:
            failures.append("a glossed term reached the page unexplained")

    # the stamp catches a page edited after building
    page = build.stamped(build.build(copy.deepcopy(GOOD), build.Ctx([], tmp)))
    if not build.verify(page):
        failures.append("a freshly built page failed its own stamp")
    if build.verify(page.replace("Mirror Blur Fix", "Something Else")):
        failures.append("an edited page passed the stamp")
    if build.verify("<title>hand written</title>"):
        failures.append("a hand-written page passed the stamp")

    # a decision may not be withdrawn once published
    old = copy.deepcopy(GOOD)
    build.previous = lambda _p: old
    spec = copy.deepcopy(GOOD)
    spec["decisions"] = [spec["decisions"][0]]
    if not any("D2 vanished" in p for p in build.validate(spec, spec_path)[0]):
        failures.append("a withdrawn decision number went unnoticed")
    spec = copy.deepcopy(GOOD)
    spec["decisions"][1]["title"] = "The short circuit is the test we trust"
    if not any("D2 now says" in p for p in build.validate(spec, spec_path)[0]):
        failures.append("a decision rewritten under its old number went unnoticed")
    build.previous = lambda _p: None
    # Every question names a card, so every build here asks the board about one.
    # The cases that are not about that rule get a board that says "still open".
    build.card_state = lambda card, project, base=None: "open"

    # a card with nothing under it refuses, rather than quietly showing no work
    spec = copy.deepcopy(GOOD)
    spec["status"] = {"card": "nope-0"}
    try:
        build.build(spec, build.Ctx([], tmp, tmp))
        failures.append("a card with no work under it: built anyway")
    except ReportError as e:
        if "checklist" not in str(e) and "board" not in str(e):
            failures.append(f"a card with no work under it: unhelpful complaint — {e}")

    # a report made in a worktree is filed under the project, whose name outlives
    # the branch the worktree is named after
    import project as project_mod
    git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
    repo = tmp / "some-project"
    (repo / "sub").mkdir(parents=True)
    (tmp / "nowhere").mkdir()
    subprocess.run(git + ["init", "-q", str(repo)], check=True, capture_output=True)
    subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "x"],
                   cwd=repo, check=True, capture_output=True)
    subprocess.run(git + ["worktree", "add", "-q", "--detach", str(tmp / "a-branch-name")],
                   cwd=repo, check=True, capture_output=True)
    for where, said in [(repo, "the project itself"),
                        (repo / "sub", "a directory inside the project"),
                        (tmp / "a-branch-name", "a worktree"),
                        (tmp / "nowhere", "a directory under no project")]:
        want = "nowhere" if where.name == "nowhere" else "some-project"
        got = project_mod.name(where)
        if got != want:
            failures.append(f"a report made in {said} would be filed under {got!r}")

    # a spec that reads a card finds its project's board from any directory:
    # the spec's folder names the project, and the board screen's own list says
    # where that project lives — the build's directory is only the fallback
    import sqlite3
    import board as board_mod
    home = tmp / "kanban-ui"
    spec_dir = home / "reports" / "some-project"
    spec_dir.mkdir(parents=True)
    con = sqlite3.connect(home / "settings.db")
    con.execute("CREATE TABLE projects (name TEXT, path TEXT)")
    con.execute("INSERT INTO projects VALUES ('Some Project', ?)", (str(repo),))
    con.commit()
    con.close()
    elsewhere = tmp / "nowhere"
    if board_mod.board_home(spec_dir, elsewhere) != repo:
        failures.append("a build run outside the project did not find its board from the screen's list")
    if board_mod.board_home(home / "reports" / "unlisted-project", elsewhere) != elsewhere:
        failures.append("an unlisted project did not fall back to the build's own directory")

    # ── the two status lines describe the whole board, not its first row ──
    # From here on the board is a fixture, so nothing below may reach `bd`.
    board_mod._under_way = lambda kid, project: False
    full = [{"id": "a", "title": "Alpha", "status": "closed"},
            {"id": "b", "title": "Bravo", "status": "open"},
            {"id": "c", "title": "Charlie", "status": "in_progress"},
            {"id": "d", "title": "Delta", "status": "in_progress"}]

    board_mod.children = lambda card, project: full
    st = board_mod.status("x", tmp)
    if [i["state"] for i in st["items"]] != ["done", "todo", "draft", "draft"]:
        failures.append("the checklist is not in the order the job runs")
    if st["next_up"] != "Bravo":
        failures.append(f"next up did not name the one unstarted item — {st['next_up']!r}")
    if "1 more" not in st["now"]:
        failures.append(f"now named one live item and hid the other — {st['now']!r}")

    board_mod.children = lambda card, project: [k for k in full if k["status"] != "open"]
    st = board_mod.status("x", tmp)
    if "under way" not in st["next_up"]:
        failures.append(f"with nothing unstarted, next up reads as finished — {st['next_up']!r}")

    # the run of the job, not the state of each row: a checklist sorted by state
    # reads as two lists running in opposite directions
    board_mod.children = lambda card, project: [
        {"id": "j.10", "status": "open", "title": "Tenth", "created_at": "2026-08-13T05:17:07"},
        {"id": "j.9", "status": "closed", "title": "Ninth", "created_at": "2026-08-13T05:17:07"},
        {"id": "j.2", "status": "closed", "title": "Second", "created_at": "2026-08-13T04:57:55"},
        {"id": "j.11", "status": "open", "title": "Eleventh", "created_at": "2026-08-13T05:17:07"},
    ]
    said = [i["text"] for i in board_mod.status("x", tmp)["items"]]
    if said != ["Second", "Ninth", "Tenth", "Eleventh"]:
        failures.append(f"the checklist came out as {said}")
    if board_mod.status("x", tmp)["next_up"] != "Tenth":
        failures.append("next up is not the earliest row nobody has started")

    # written and waiting to merge is work under way, not work nobody has started;
    # work that was dropped is neither, and leaves the list
    board_mod.children = lambda card, project: [
        {"id": "k.1", "status": "in_review", "title": "Written"},
        {"id": "k.2", "status": "manager_review", "title": "Waiting on him"},
        {"id": "k.3", "status": "closed", "labels": ["cancelled"], "title": "Dropped"},
        {"id": "k.4", "status": "open", "title": "Untouched"},
    ]
    st = board_mod.status("x", tmp)
    if [i["state"] for i in st["items"]] != ["draft", "draft", "todo"]:
        failures.append(f"unmerged work read as {[i['state'] for i in st['items']]}")
    if any(i["text"] == "Dropped" for i in st["items"]):
        failures.append("work that was dropped is still on the checklist")

    # a job's own steps reach the reader by purpose, not by this system's name
    board_mod.children = lambda card, project: [
        {"id": "s", "status": "open", "labels": ["step:build", "of:x"],
         "title": "Build: the whole goal title again"},
        {"id": "w", "status": "open", "labels": ["step:worktree", "of:x"],
         "title": "Worktree: the whole goal title again"},
    ]
    st = board_mod.status("x", tmp)
    said = [i["text"] for i in st["items"]]
    if said != ["Build it", "Get a clean workspace"]:
        failures.append(f"a job's steps reached the reader as {said}")

    # a step nobody has given plain words to still reads as a name, not a label
    board_mod.children = lambda card, project: [
        {"id": "p", "status": "open", "labels": ["step:polish", "of:x"], "title": "Polish: x"},
    ]
    if board_mod.status("x", tmp)["items"][0]["text"] != "Polish":
        failures.append("an unknown step name leaked its label into the checklist")

    # many cards under one step ARE the work: each is told apart by its own title,
    # and printing the step's name would print it once per card
    board_mod.children = lambda card, project: [
        {"id": "a", "status": "closed", "labels": ["step:work", "of:x"], "title": "Fix the button"},
        {"id": "b", "status": "open", "labels": ["step:work", "of:x"], "title": "Refuse the close"},
        {"id": "c", "status": "open", "labels": ["step:work", "of:x"], "title": "Write the rule down"},
    ]
    said = [i["text"] for i in board_mod.status("x", tmp)["items"]]
    if said != ["Fix the button", "Refuse the close", "Write the rule down"]:
        failures.append(f"work items sharing a step read as {said}")

    # README, "Next-up is the exception"
    board_mod.children = lambda card, project: [
        {"id": "m.1", "status": "open", "labels": ["step:work", "of:x"], "title": "Build it"},
    ]
    spec = copy.deepcopy(GOOD)
    spec["status"] = {"card": "x"}
    spec["next"]["steps"] = [{"step": "Drive the long circuit", "cost": "small"},
                             {"step": "Fit the second mirror", "cost": "small", "starting": True}]
    # the one line, not the whole page: the plan's words appear further down every
    # page and the work list's words are in the ticks right beside it
    def next_up_line(s):
        got = re.search(r"Next up</b> <span>([^<]*)",
                        build.status_card(s, build.Ctx([], tmp, tmp)))
        return got.group(1) if got else ""

    if next_up_line(spec) != "Fit the second mirror":
        failures.append(f"next up said {next_up_line(spec)!r}, not what the agent is about to do")
    spec["next"]["steps"] = []
    if next_up_line(spec) != "Build it":
        failures.append("with the plan run out, next up did not fall back to the work list")

    # a job with nothing left keeps the work list's last word, whatever the plan
    # still advertises
    board_mod.children = lambda card, project: [
        {"id": "m.1", "status": "closed", "labels": ["step:work", "of:x"], "title": "Build it"},
    ]
    spec["next"]["steps"] = [{"step": "Fit the second mirror", "cost": "small", "starting": True}]
    if "finished" not in next_up_line(spec):
        failures.append(f"a finished job still advertised {next_up_line(spec)!r} as next")

    # a card's title reaches the manager unedited, so it answers to the phrasebook
    board_mod.children = lambda card, project: [
        {"id": "j", "status": "open", "labels": ["step:work", "of:x"],
         "title": "Refactor the shader in render.rs"},
        {"id": "k", "status": "open", "labels": ["step:work", "of:x"],
         "title": "Make the mirrors read clearly"},
    ]
    spec = copy.deepcopy(GOOD)
    spec["status"] = {"card": "x"}
    ctx = build.Ctx([], tmp, tmp)
    build.build(spec, ctx)
    if not any("shader" in w for w in ctx.warnings):
        failures.append("a card titled in our own words reached the manager unflagged")
    if any("mirrors" in w for w in ctx.warnings):
        failures.append("a plainly titled card was flagged")

    # a question is refused once the card it is holding up is finished, and the
    # same question builds while that card is still open
    for finished in ("closed", "cancelled"):
        build.card_state = lambda card, project, base=None: finished
        try:
            build.build(copy.deepcopy(GOOD), build.Ctx([], tmp))
            failures.append(f"a question holding up a {finished} card: printed anyway")
        except ReportError as e:
            if "x.2" not in str(e):
                failures.append(f"a question holding up a {finished} card: did not name it — {e}")
    build.card_state = lambda card, project, base=None: None
    try:
        build.build(copy.deepcopy(GOOD), build.Ctx([], tmp))
        failures.append("a question holding up a card the board never heard of: printed anyway")
    except ReportError:
        pass

    # two dead questions are both named, or the second costs another build to find
    spec = copy.deepcopy(GOOD)
    spec["actions"]["questions"].append(copy.deepcopy(spec["actions"]["questions"][0]))
    spec["actions"]["questions"][1]["holds"] = "x.3"
    build.card_state = lambda card, project, base=None: "closed"
    try:
        build.build(spec, build.Ctx([], tmp))
        failures.append("two questions holding up finished cards: printed anyway")
    except ReportError as e:
        if "x.2" not in str(e) or "x.3" not in str(e):
            failures.append(f"two dead questions, and the refusal named one of them — {e}")
    build.card_state = lambda card, project, base=None: "open"
    build.build(copy.deepcopy(GOOD), build.Ctx([], tmp))

    # a machine with no board cannot say either way, so it says so and builds
    def no_board(card, project, base=None):
        raise board_mod.NoBoard

    build.card_state = no_board
    ctx = build.Ctx([], tmp)
    build.build(copy.deepcopy(GOOD), ctx)
    if not any("no board" in n for n in ctx.notes):
        failures.append("a build with no board to ask said nothing about what it could not check")
    if ctx.warnings:
        failures.append("what the build could not check was counted as words to plain up")
    build.card_state = lambda card, project, base=None: "open"

    # the board's own answer, read the way card_state itself reads it — the
    # cases above hand it a state, and none of them exercise the reading
    class Answer:
        def __init__(self, code, out, err=""):
            self.returncode, self.stdout, self.stderr = code, out, err

    real_run = board_mod.subprocess.run
    for how, payload, want in [
        ("its status", {"id": "x", "status": "dropped"}, "cancelled"),
        ("a refusal", {"id": "x", "status": "wontfix"}, "cancelled"),
        ("a word on it", {"id": "x", "status": "closed", "labels": ["dropped"]}, "cancelled"),
        ("nothing", {"id": "x", "status": "in_progress"}, "in_progress"),
    ]:
        board_mod.subprocess.run = lambda *a, **k: Answer(0, json.dumps(payload))
        got = board_mod.card_state("x", tmp)
        if got != want:
            failures.append(f"a card dropped by {how} read as {got!r}, not {want!r}")

    board_mod.subprocess.run = lambda *a, **k: Answer(
        1, '{"error": "no issues found matching the provided IDs"}')
    if board_mod.card_state("x", tmp) is not None:
        failures.append("a card the board has never heard of did not read as unknown")

    board_mod.subprocess.run = lambda *a, **k: Answer(1, "", "no beads database found")
    try:
        board_mod.card_state("x", tmp)
        failures.append("a board that could not answer at all was read as an unknown card")
    except board_mod.BoardSilent as why:
        if "no beads database" not in str(why):
            failures.append(f"a broken board's own reason never reached anyone — {why}")
    board_mod.subprocess.run = real_run

    # and that reason is what the reader is told, rather than to rename a card
    # that was never the problem
    def silent(card, project, base=None):
        raise board_mod.BoardSilent("no beads database found")

    build.card_state = silent
    try:
        build.build(copy.deepcopy(GOOD), build.Ctx([], tmp))
        failures.append("a page nothing could be checked against was built anyway")
    except ReportError as e:
        if "no beads database" not in str(e):
            failures.append(f"the build hid why the board went quiet — {e}")
    build.card_state = lambda card, project, base=None: "open"

    # what the build could not check reaches the line handed over with the link,
    # or a page still asking about unconfirmed work goes out looking whole
    said = build.tally("x" * 1024, GOOD, [], ["question 1 says it is holding up x.2"])
    if "nobody could confirm" not in said:
        failures.append(f"the line handed over said nothing about what was unchecked — {said}")
    if "nobody could confirm" in build.tally("x" * 1024, GOOD, [], []):
        failures.append("a fully checked page was reported as unconfirmed")

    for f in failures:
        print("FAIL  " + f)
    print(f"{len(CASES) + 45 - len(failures)}/{len(CASES) + 45} report gates hold")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(run())
