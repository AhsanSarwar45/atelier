#!/usr/bin/env python3
"""The playbook, as the steps a job runs — and what proves each one.

This file is the playbook's only home. A step is created only when the step
before it closes: at the moment a job is poured nobody can say what "checks"
will mean for it, and a step created then can only carry the template's own
words — which is what made a board of identical rows.
See docs/board.md#4-the-shape-of-a-job.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import sections  # noqa: E402

# What proves a step, declared here once so the close gate reads it instead of
# trusting a label somebody remembered to add.
#   commit  the change is on main, named by a commit that names THIS step
#   note    makes no code; what it did is written on the card, in its own shape
#   fact    a condition outside the board that a machine can read
#   work    no card of its own: the job's real work items stand here, as the job's
#           own children, so a board counts progress in the work and not in a
#           container nobody can read
#   read    no card of its own either: the goal is what is read, so the goal carries
#           the signature. A card here would be a piece of the job that is open
#           exactly while the job is meant to have none (board/reading.py)
COMMIT, NOTE, FACT, WORK, READ = "commit", "note", "fact", "work", "read"

# Whether a job runs the step at all.
#   must    every job, and it is neither picked nor dropped
#   picked  only when the pour names it in --steps — or when the job's own words
#           select it, which nobody has to remember to ask for (see `auto`)
#   gone    not a step of today's playbook. A job poured while it was one still
#           runs the order written on it, so the catalogue still answers for it
MUST, PICKED, GONE = "must", "picked", "gone"

# id, title verb, what the step is for, what proves it, whether a job runs it.
#
# Four steps, not eleven. The eleven were ceremony a job paid before it was
# allowed to start: an isolated tree and the questions worth asking are still
# required, but they are what the pour already asks for and the gates already
# hold, not cards somebody closes one by one (bw-510, bw-a6o.2).
STEPS = [
    ("ground", "Ground",
     "The technique or outside behaviour this job turns on, read from the source that "
     "defines it — never from memory.\n\n## Acceptance Criteria\nEvery claim the design "
     "will rest on is on this card with the source it came from.",
     NOTE, PICKED),
    ("design", "Design",
     "What will change and why that is the right shape, stated as effects. The manager "
     "approves before anyone builds, and the work items go under the goal itself "
     "(`%(pour)s under <goal>`).\n\n## Acceptance Criteria\nThe manager has said "
     "yes, the yes is on this card, and the job carries the items this design decided.",
     NOTE, PICKED),
    ("work", "Work",
     "The change itself, as the items the design decided — poured under the goal by "
     "`%(pour)s under <goal>`, never behind a card called Build.\n\n"
     "## Acceptance Criteria\nEvery work item is closed and its commit is on main.",
     WORK, MUST),
    ("checks", "Checks",
     "This project's own checks, run once over everything the job built, in front of "
     "the reader: %(checks)s. Once a job and nowhere else — held per edit or per "
     "commit they are the same minutes paid again for a change nobody has finished "
     "making.\nWhat a change here has to do before it counts as proved: %(proves)s.\n\n"
     "## Acceptance Criteria\n%(done)s\n\nThe exact command and the count it came back "
     "with are on this card.",
     NOTE, MUST),
    ("benchmark", "Benchmark",
     "The number this job claims, measured both ways.\n\n## Acceptance Criteria\nThe "
     "before and the after are on this card, each with the command that produced it.",
     NOTE, PICKED),
    ("review", "Review",
     "One optional external reading, chosen after the actual change and checks are "
     "known. It is never launched automatically and is never repeated.\n\n"
     "## Acceptance Criteria\nThe single attempt is recorded, and every point it "
     "raised is either fixed or answered on a piece of the job.",
     READ, PICKED),
    ("record", "Record",
     "The durable facts go into the document that owns the subject — %(record)s — and "
     "shortcuts taken go on that document's debt list.\n\n## Acceptance Criteria\nThe "
     "facts are in the owning document, the debt is listed, and this card carries "
     "nothing a reader needs later.",
     COMMIT, PICKED),
    ("land", "Land",
     "Teardown. Every code step merged as it closed, so nothing is left to land — what is "
     "left is the tree, the branch and the slot.\n\n## Acceptance Criteria\nThe branch is "
     "merged and gone, the worktree is removed, and the merge slot is released.",
     FACT, MUST),
]

# Steps no job is poured with any more, kept because a job poured under them runs
# the order stored on its own goal — and a run whose next position the catalogue
# cannot answer for is a job that stops moving. What each was, and where it went:
#   worktree  still required, and the gates still hold it: a no-code step cannot
#             close from outside `worktrees/<goal>`, and the landing reads the tree
#             and branch being gone as its own fact
#   clarify   what the pour asks for in `--what` and `--evidence`
#   prove     what the pour asks for in `--evidence`
#   verify    the checks step, which runs the project's declared command instead of
#             whatever the closing session felt like running
#   test      the checks step again: a guard that only exists is worth nothing, and
#             a guard that runs is part of what the command comes back with
RETIRED = [
    ("worktree", "Worktree",
     "An isolated tree, so two jobs never edit the same file under each other.\n\n"
     "## Acceptance Criteria\nThe tree is under `worktrees/`, this session is inside "
     "it, and its branch was cut from main.",
     FACT, GONE),
    ("clarify", "Clarify",
     "The questions whose answers change what gets built, asked before anything is "
     "designed.\n\n## Acceptance Criteria\nThe questions and their answers are on this "
     "card. If nothing was unclear, that is the answer and it is written here.",
     NOTE, GONE),
    ("prove", "Prove",
     "Run it and watch the fault happen before anything is changed.\n\n"
     "## Acceptance Criteria\nThe run is on this card: the exact command, and the number "
     "or image it produced. If it does not reproduce, close the whole job as not real.",
     NOTE, GONE),
    ("verify", "Verify",
     "Run the thing and read the result. A build that compiles is not a verified change.\n"
     "What that means here: %(proves)s.\n\n"
     "## Acceptance Criteria\n%(done)s\n\nThe run and its number or image are on this card.",
     NOTE, GONE),
    ("test", "Guard",
     "The fault must not be able to return unnoticed.\n\n## Acceptance Criteria\nA check "
     "exists whose threshold comes from the measured value, and it has been shown to go "
     "red when the fault is put back.",
     COMMIT, GONE),
]
BY_ID = {s[0]: s for s in STEPS + RETIRED}
ORDER = [s[0] for s in STEPS]

# A job that claims a speed win owes a before and an after. Read off the job's own
# success criteria, so nobody has to remember to ask for it.
PERF = re.compile(r"\b(faster|slower|speed-?ups?|ms\b|µs|fps\b|frame-?time|latency|"
                  r"throughput|per-frame cost|allocations?/|hitch|stutter)\b", re.I)

# A job whose finish line is a document owes the writing of it. Same reading as the
# speed claim above, and for the same reason: the step arrives because the job said
# so, not because somebody remembered the step existed.
DOC = re.compile(r"\b(?:docs?/[\w./-]+|[\w./-]+\.(?:md|rst|adoc))\b", re.I)

# A success criterion no agent can settle. The manager's own test, 2026-08-13:
# "things than an agent can't decide. like how good does this rendering look."
# Narrow on purpose — a word that also has an ordinary use would refuse honest pours.
LOOKS = re.compile(r"\b(photo-?real\w*|realistic|convincing|believable|plausible|"
                   r"looks? (?:right|correct|good|better|natural|real)|"
                   r"how it looks|the way it looks|appearance)\b", re.I)


def judged_by_eye(done):
    """Whether a job's success criteria can only be settled by looking."""
    return bool(LOOKS.search(done or ""))


# What a step used to be called. A job poured before a rename carries the old id in
# its own stored order, and that order is what its run is read from.
LEGACY = {"build": "work"}


def now(sid):
    """A step id in today's spelling. Every reader of a stored id goes through
    here, or a renamed step reads as one nothing in the catalogue answers for."""
    return LEGACY.get(sid, sid)


def stored(csv):
    """The order recorded on a goal, in today's spelling."""
    return [now(s) for s in (csv or "").split(",") if s]


def evidence(sid):
    sid = now(sid)
    return BY_ID[sid][3] if sid in BY_ID else COMMIT


def tier(sid):
    sid = now(sid)
    return BY_ID[sid][4] if sid in BY_ID else MUST


def mandatory():
    return [s[0] for s in STEPS if s[4] == MUST]


def optional():
    """The steps a job runs only when it says so — named in `--steps`, or selected
    by the job's own words (`auto`). Nothing here is guessed and nothing is owed:
    a step nobody asked for is a step nobody has to refuse in writing."""
    return [s[0] for s in STEPS if s[4] == PICKED]


def auto(done, record=""):
    """Steps the job's own words select without being asked."""
    picked = []
    if PERF.search(done or ""):
        picked.append("benchmark")
    if record or DOC.search(done or ""):
        picked.append("record")
    return picked


def order(picked):
    """This job's run of steps, in catalogue order. Mandatory steps are never absent."""
    want = set(mandatory()) | set(picked or [])
    return [sid for sid in ORDER if sid in want]


# What a note has to carry before its step may close, per step. A step that makes no
# code is proved by what it wrote, so "thirty characters of anything" is not proof.
# What counts as runnable is a card's own bar, read from where it is defined
# (docs/board.md#4e-what-a-section-has-to-carry) — a step's proof and a card's
# finish line mean the same thing by it.
COMMAND = sections.COMMAND
_TWO_NUMBERS = re.compile(r"\d+(?:\.\d+)?\s*(?:ms|µs|us|s|fps|%|x|MB|KB|B)\b", re.I)


def _has_run(text):
    return bool(COMMAND.search(text)) and bool(re.search(r"\d", text))


NOTE_SHAPE = {
    "checks": (_has_run, "the exact command you ran and the count it came back with"),
    "ground": (lambda t: bool(re.search(r"https?://|\bdocs/|\b[\w./-]+\.(?:md|pdf|rs|py|"
                                        r"wgsl|ini|toml|html)\b", t)),
               "the source each claim came from — a URL or a path, not a memory"),
    "design": (lambda t: bool(re.search(r"\b(approved|said yes|go[- ]ahead|manager'?s yes)"
                                        r"\b", t, re.I)),
               "the manager's yes, in the manager's words"),
    "benchmark": (lambda t: len(_TWO_NUMBERS.findall(t)) >= 2,
                  "a before and an after, each a number with its unit"),
    # Retired positions. A job poured under them is still closing them, and a note
    # bar that vanished the day the step did would let those closes through on
    # anything at all.
    "clarify": (lambda t: "?" in t and len(t) >= 60,
                "the questions asked and the answers given back"),
    "prove": (_has_run, "the exact command, and the number or image it produced"),
    "verify": (_has_run, "the command you ran and the number or image it produced"),
}


def note_ok(sid, notes):
    """Whether this step's note carries its own evidence. Returns (ok, what is missing)."""
    shape = NOTE_SHAPE.get(now(sid))
    if not shape:
        return True, ""
    test, wanted = shape
    return bool(test(notes or "")), wanted


def subject(what, limit=54):
    """A short handle for the job, so a step's title names its own job rather
    than repeating a verb the whole board shares."""
    text = re.split(r";|\s+—\s+", what.strip())[0].strip().rstrip(".")
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",") + "…"


def settle(cid, labels):
    """`bd update` arguments that make a card's labels exactly `labels`.

    Creating with `--parent` copies the parent's labels down, so a job poured
    under a container arrives wearing the container's tags as well as its own.
    """
    return ["update", cid, "--set-labels", ",".join(labels)]


def step_labels(sid, goal, meta):
    """Exactly the labels a step wears, and the only place they are listed.

    `of:` carries the goal, because a card does not report its parent and the next
    step has to be opened from a closed one without a search. Both tags come from
    the goal: a step is never a different system or kind from the job it is part of.
    """
    out = ["step:" + sid, "of:" + goal, "area:" + meta.get("area", "board"),
           "kind:" + meta.get("kind", "chore")]
    if evidence(sid) not in (COMMIT, WORK):
        out.append("no-code")
    return out


def card(sid, goal, meta, priority):
    """The bd create arguments for one step of a job."""
    if evidence(sid) == WORK:
        raise ValueError("the work position has no card: its items are the job's own "
                         "children, poured by `%s under <goal>`" % sections.EG_POUR)
    if evidence(sid) == READ:
        raise ValueError("the reading position has no card: the goal is what is read, "
                         "and it carries the signature (board/reading.py)")
    _, verb, body, _, _ = BY_ID[now(sid)]
    labels = step_labels(sid, goal, meta)
    # The project's own answers, off the goal where the pour wrote them: a step is
    # opened weeks later by whichever session closed the one before it, standing in
    # whatever checkout that was, and a command read from there is another
    # project's.
    fill = {"done": meta.get("done", ""), "pour": sections.EG_POUR,
            "proves": sections.PROVES,
            "checks": ("`%s`" % meta["checks"]) if meta.get("checks") else
                      "this project's external Atelier metadata declares no checks command, so "
                      "run what holds a change here and say on the card what that was",
            "record": meta.get("record") or "the one this job's success criteria name"}
    args = ["create", "--title", "%s: %s" % (verb, meta.get("subject", "")),
            "--type", "task", "-p", str(priority), "--parent", goal,
            "-d", body % fill]
    for lab in labels:
        args += ["-l", lab]
    return args
