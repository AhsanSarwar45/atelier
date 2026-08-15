#!/usr/bin/env python3
"""The playbook, as the steps a job runs — and what proves each one.

This file is the playbook's only home. A step is created only when the step
before it closes: at the moment a job is poured nobody can say what "verify"
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

# Whether a job may leave the step out.
#   must    never
#   reason  yes, and the reason is written onto the goal
#   auto    the job's own success criteria decide (see `auto`)
MUST, REASON, AUTO = "must", "reason", "auto"

# id, title verb, what the step is for, what proves it, whether it may be dropped.
STEPS = [
    ("worktree", "Worktree",
     "An isolated tree, so two jobs never edit the same file under each other.\n\n"
     "## Acceptance Criteria\nThe tree is under `worktrees/`, this session is inside "
     "it, and its branch was cut from main.",
     FACT, MUST),
    ("clarify", "Clarify",
     "The questions whose answers change what gets built, asked before anything is "
     "designed.\n\n## Acceptance Criteria\nThe questions and their answers are on this "
     "card. If nothing was unclear, that is the answer and it is written here.",
     NOTE, MUST),
    ("prove", "Prove",
     "Run it and watch the fault happen before anything is changed.\n\n"
     "## Acceptance Criteria\nThe run is on this card: the exact command, and the number "
     "or image it produced. If it does not reproduce, close the whole job as not real.",
     NOTE, MUST),
    ("ground", "Ground",
     "The technique or outside behaviour this job turns on, read from the source that "
     "defines it — never from memory.\n\n## Acceptance Criteria\nEvery claim the design "
     "will rest on is on this card with the source it came from.",
     NOTE, REASON),
    ("design", "Design",
     "What will change and why that is the right shape, stated as effects. The manager "
     "approves before anyone builds, and the work items go under the goal itself "
     "(`%(pour)s under <goal>`).\n\n## Acceptance Criteria\nThe manager has said "
     "yes, the yes is on this card, and the job carries the items this design decided.",
     NOTE, REASON),
    ("work", "Work",
     "The change itself, as the items the design decided — poured under the goal by "
     "`%(pour)s under <goal>`, never behind a card called Build.\n\n"
     "## Acceptance Criteria\nEvery work item is closed and its commit is on main.",
     WORK, MUST),
    ("verify", "Verify",
     "Run the thing and read the result. A build that compiles is not a verified change.\n"
     "What that means here: %(proves)s.\n\n"
     "## Acceptance Criteria\n%(done)s\n\nThe run and its number or image are on this card.",
     NOTE, MUST),
    ("benchmark", "Benchmark",
     "The number this job claims, measured both ways.\n\n## Acceptance Criteria\nThe "
     "before and the after are on this card, each with the command that produced it.",
     NOTE, AUTO),
    ("test", "Guard",
     "The fault must not be able to return unnoticed.\n\n## Acceptance Criteria\nA check "
     "exists whose threshold comes from the measured value, and it has been shown to go "
     "red when the fault is put back.",
     COMMIT, REASON),
    ("review", "Review",
     "One round, by someone who did not write it. The board fires that reader itself "
     "when the job's last piece closes, and holds the goal shut with a gate until one "
     "has read the change.\n\n## Acceptance Criteria\nA reader that did not write the "
     "job has signed the goal, and every point it raised is either fixed or answered "
     "on a piece of the job.",
     READ, MUST),
    ("record", "Record",
     "The durable facts go into the document that owns the subject; shortcuts taken go on "
     "that document's debt list.\n\n## Acceptance Criteria\nThe facts are in the owning "
     "document, the debt is listed, and this card carries nothing a reader needs later.",
     COMMIT, MUST),
    ("land", "Land",
     "Teardown. Every code step merged as it closed, so nothing is left to land — what is "
     "left is the tree, the branch and the slot.\n\n## Acceptance Criteria\nThe branch is "
     "merged and gone, the worktree is removed, and the merge slot is released.",
     FACT, MUST),
]
BY_ID = {s[0]: s for s in STEPS}
ORDER = [s[0] for s in STEPS]

# A job that claims a speed win owes a before and an after. Read off the job's own
# success criteria, so nobody has to remember to ask for it.
PERF = re.compile(r"\b(faster|slower|speed-?ups?|ms\b|µs|fps\b|frame-?time|latency|"
                  r"throughput|per-frame cost|allocations?/|hitch|stutter)\b", re.I)

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


def droppable():
    """The steps a job answers for at pour time — each is taken or refused in writing."""
    return [s[0] for s in STEPS if s[4] == REASON]


def auto(done):
    """Steps the job's own success criteria select without being asked."""
    return ["benchmark"] if PERF.search(done or "") else []


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
    "clarify": (lambda t: "?" in t and len(t) >= 60,
                "the questions asked and the answers given back"),
    "prove": (_has_run, "the exact command, and the number or image it produced"),
    "ground": (lambda t: bool(re.search(r"https?://|\bdocs/|\b[\w./-]+\.(?:md|pdf|rs|py|"
                                        r"wgsl|ini|toml|html)\b", t)),
               "the source each claim came from — a URL or a path, not a memory"),
    "design": (lambda t: bool(re.search(r"\b(approved|said yes|go[- ]ahead|manager'?s yes)"
                                        r"\b", t, re.I)),
               "the manager's yes, in the manager's words"),
    "verify": (_has_run, "the command you ran and the number or image it produced"),
    "benchmark": (lambda t: len(_TWO_NUMBERS.findall(t)) >= 2,
                  "a before and an after, each a number with its unit"),
}


def note_ok(sid, notes):
    """Whether this step's note carries its own evidence. Returns (ok, what is missing)."""
    shape = NOTE_SHAPE.get(sid)
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
    _, verb, body, _, _ = BY_ID[sid]
    labels = step_labels(sid, goal, meta)
    args = ["create", "--title", "%s: %s" % (verb, meta.get("subject", "")),
            "--type", "task", "-p", str(priority), "--parent", goal,
            "-d", body % {"done": meta.get("done", ""), "pour": sections.EG_POUR,
                          "proves": sections.PROVES}]
    for lab in labels:
        args += ["-l", lab]
    return args
