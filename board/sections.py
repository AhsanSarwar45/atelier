#!/usr/bin/env python3
"""What each section of a card has to carry before it may reach the board.

One home, because three readers ask the same question: the pour, when a card is
written; the sweep, when an old card is measured; and the reader, when a job is
judged. Three copies of "is this a real finish line" would drift into three
different boards.

⛔ Every bar here is a test a machine can run, and none of them is a length. A
character count is met by padding, and padding is what produced the cards the
manager could not read. See docs/board.md#4e-what-a-section-has-to-carry.

What these bars cannot do: they read shape, never truth. A finish line naming a
command that proves nothing passes here and is caught by the reader (cor-5nnw).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import project  # noqa: E402

# A claim a machine can act on: something to run, in backticks or named outright.
# The one definition — `board/spine.py` reads it from here for its note rules, so
# a step's proof and a card's finish line mean the same thing by it.
COMMAND = re.compile(r"`[^`]+`|(?:^|\s)(?:scripts/|\./)\S|"
                     r"(?:^|\s)(?:cargo|python3?|bd|npx|npm|node|git|gh|grep|rg|report|"
                     r"curl|playwright|pytest|make)\b")
IMAGE = re.compile(r"\b[\w./-]+\.(?:png|jpg|jpeg|webp)\b", re.I)
# Somewhere to go and look: a path, or a file named by its kind.
PATH = re.compile(r"[\w.~-]*/[\w./-]+|\b[\w.-]+\.(?:rs|py|md|toml|ini|wgsl|json|tsx?|"
                  r"jsx?|sh|html|ya?ml|txt|csv|sql|lua|kn5|dds|hlsl|glsl)\b", re.I)

# A goal written as its own fix, which is a goal with no test
# (docs/board.md#4-the-shape-of-a-job) and was enforced nowhere.
FIX_VERB = re.compile(r"^\W*(fix|add|make|implement|support|enable|improve|refactor|"
                      r"handle|rewrite|remove|update|clean\s+up|port|introduce|create|"
                      r"allow|ensure|provide|hook\s+up|wire)\b", re.I)
# The whole claim being an adjective — "The board is bad" says nothing anyone can
# look for. Deliberately the whole line and nothing less: "the shadow lands in the
# wrong place" names a behaviour and has to keep passing.
NOTHING_SAID = re.compile(r"^\W*(?:the|a|an|it|this|that)?\s*[\w' -]{1,40}\s+"
                          r"(?:is|are|was|were|feels?|seems?|looks?)\s+(?:not\s+|un)?"
                          r"(?:bad|broken|wrong|slow|ugly|messy|janky|poor|weird|awful|"
                          r"terrible|good|right|fine|ok|okay|working|great)\W*$", re.I)
# Never a finish line, whatever else stands beside it. Words with an honest use in
# a tolerance — roughly, about, approximately — are deliberately absent.
HEDGE = re.compile(r"\b(feels? right|probably|should be fine|more or less|hopefully|"
                   r"good enough|we think|if it works|when it'?s done|seems fine|"
                   r"as expected|sensible|reasonable)\b", re.I)
# What the run must come out as. Not a number, but still something the run itself
# settles rather than a reader's impression.
VERDICT = re.compile(r"\b(non-?zero|exit code|goes? red|turns? red|stays? green|"
                     r"refus\w+|accept\w+|passes|fails?|failures?|empty|unchanged|green|"
                     r"identical|matches|prints?|reports?|exits?|names?|resolves?|"
                     r"returns?|records?|shows?)\b", re.I)
# The sentence the pour used to print into every card's scope section.
TEMPLATE = "found on the way becomes its own card"
# How a fault shows itself, as opposed to where it lives.
SHOWS = re.compile(r"\b(shows?|prints?|draws?|renders?|reads?|returns?|exits?|fails?|"
                   r"refuses?|accepts?|passes|reports?|logs?|crashes|hangs|throws|"
                   r"ignores?|hides?|drops?|skips?|counts?|orders?|groups?|lists?|"
                   r"names?|treats?|leaves?|holds?|sends?|opens?|closes?|stalls?)\b", re.I)

# The three things below differ by project and are read off its declaration
# (`machinery.toml`, one per project): the systems a card may belong to, the shape
# of its card ids, and the ways this project names somewhere to go and look that
# are not a file — a debug view in a renderer, a screen in an app.
AREAS, CARD, PLACE = [], None, None
# A refusal shows the sentence to write instead, and one written in another
# project's card ids and another project's systems teaches nothing here. Both are
# read off the declaration with the rest.
EG_CARD, EG_AREA, EG_POUR, EG_SUITE = "bd-1a2b", "another system", "job", "selftest.py"
# What a change in this project has to do before it counts as proved. Written
# into the Verify step of every job poured here and told to the outside reader,
# so the one sentence answers in both places.
PROVES = "run the thing and read what it produced"


def use(root=None):
    """Answer for the project holding `root` from here on.

    Called at import for the project this process is standing in, and again by any
    tool that has to answer for a different one — the reader of a job, or the
    suite running each project's declaration in turn.
    """
    global AREAS, CARD, PLACE, EG_CARD, EG_AREA, EG_POUR, EG_SUITE, PROVES
    decl = project.of(root)
    AREAS = decl.areas
    known = project.prefixes(decl)
    CARD = re.compile(r"\b(?:%s)-[a-z0-9]{3,}(?:\.\d+)?\b"
                      % "|".join(re.escape(p) for p in known), re.I) if known else None
    PLACE = decl.place_re
    EG_CARD = (decl.prefix or "bd") + "-1a2b"
    EG_AREA = AREAS[0] if AREAS else "another system"
    EG_POUR = project.tool(decl, "job")
    EG_SUITE = project.tool(decl, "selftest.py")
    PROVES = decl.proves or PROVES
    return decl


use()


# A finish line often quotes the bad sentence it is there to refuse, so a hedge
# inside quotes is an example rather than a hedge.
QUOTED = re.compile(r"\"[^\"]{2,}\"|'[^']{2,}'|`[^`]+`|“[^”]+”")


def _unquoted(text):
    return QUOTED.sub(" ", text or "")


def _runnable(text):
    return bool(COMMAND.search(text or ""))


def _measurable(text):
    """Whether the run has a stated outcome — a number, an image, or a verdict.

    A verdict counts because "cargo test passes" is settled by running it, while
    a number alone was what let "roughly 1 day" through.
    """
    return (bool(re.search(r"\d", text or "")) or bool(IMAGE.search(text or ""))
            or bool(VERDICT.search(text or "")))


def _names_something(text):
    low = (text or "").lower()
    return (_runnable(text) or bool(CARD and CARD.search(text or ""))
            or bool(PATH.search(text or "")) or bool(PLACE and PLACE.search(text or ""))
            or any(a in low for a in AREAS))


def what_is_wrong(text):
    """The refusal this line earns, or "" if it states something observable."""
    text = (text or "").strip()
    if FIX_VERB.match(text):
        return ("This job's --what is an instruction, not something anyone can go and "
                "look at, and a job stated as its own fix is a job with no test. Say "
                "what goes WRONG:\n  not \"Fix the lamp\"\n  but \"The lamp draws black "
                "when the sun is behind it\"")
    if NOTHING_SAID.match(text):
        return ("This job's --what is an adjective, so there is nothing to go and "
                "look for. Say what it DOES instead:\n  not \"The board is bad\"\n  but "
                "\"The board accepts a finish line no machine can run\"")
    return ""


def finish_line(text, what="--done"):
    """The refusal this finish line earns, or "" if a machine could settle it."""
    text = (text or "").strip()
    hedge = HEDGE.search(_unquoted(text))
    if hedge:
        return ("%s hedges (%r), so nobody can be held to it. A finish line is settled "
                "by a run, not by an impression:\n  not \"`cargo test` passes and it "
                "looks good enough\"\n  but \"`cargo test` reports 0 failures and the "
                "lamp reads above 0.5\"" % (what, hedge.group(0)))
    if not _runnable(text):
        return ("%s names nothing anyone can run, so closing against it is an opinion. "
                "Name the command and what it must produce:\n  not \"it works\"\n  but "
                "\"python3 %s reports 0 failures\"" % (what, EG_SUITE))
    if not _measurable(text):
        return ("%s names a command but nothing it must produce, so any outcome "
                "satisfies it. Add the number or the image:\n  not \"the suite runs\"\n"
                "  but \"the suite reports 0 failures\"" % what)
    return ""


def left_out(text):
    """The refusal this scope line earns, or "" if it was written for this job."""
    text = (text or "").strip()
    if not text:
        return ("--not must say what this job deliberately leaves out, or the job has "
                "no edge. Name the card, the system or the file it will not touch:\n  "
                "not \"other stuff\"\n  but \"the words a card is written in "
                "(%s), and nothing under %s\"" % (EG_CARD, EG_AREA))
    if TEMPLATE in text.lower():
        return ("--not is the sentence the pour used to print into every card. Say what "
                "THIS job leaves out:\n  not \"anything found on the way becomes its "
                "own card\"\n  but \"the words a card is written in (%s), and "
                "nothing under %s\"" % (EG_CARD, EG_AREA))
    if not _names_something(text):
        return ("--not names nothing anyone could check the job against. Name the card, "
                "the system or the file this job does not touch:\n  not \"other stuff\"\n"
                "  but \"the words a card is written in (%s), and nothing under "
                "%s\"" % (EG_CARD, EG_AREA))
    return ""


def where_it_is(text):
    """The refusal a find's where-it-is earns, or "" if it can be gone and looked at."""
    text = (text or "").strip()
    if not _names_something(text):
        return ("A find's second argument must say WHERE it is — the file, the command, "
                "the system or the card. Without it the card is a rumour:\n  not \"over "
                "there\"\n  but \"%s, on every pour that names no --not\"" % EG_POUR)
    if not (SHOWS.search(text) or _measurable(text) or '"' in text or "'" in text):
        return ("A find's second argument says where it is but not HOW IT SHOWS, so "
                "nobody can tell whether it is still true. Add what it does — what it "
                "prints, draws, accepts or refuses, or the number it produced.")
    return ""


# The bars themselves. Every one is run twice: by the pour when a card is written,
# and by `faults` when a card already standing is measured. The suite holds both
# ends to this list, so a bar wired into one and not the other is caught — that is
# how a section goes back to accepting anything without anybody deciding it should.
BARS = ("what_is_wrong", "finish_line", "left_out", "where_it_is")

# A card that is still somebody's problem. A closed card is history and keeps the
# words it was written in — the sweep's own decision, cor-dlby.
LIVE = {"open", "in_progress", "manager_review", "blocked", "deferred"}
# What the pour writes above each part of a card's body, so a card can be read
# back apart the same way it was written (`board/job`).
HEADINGS = {"what": "What is wrong", "evidence": "Evidence it is real",
            "done": "Success Criteria", "not_in": "Not in this job",
            "where": "Where it is"}


def part(description, name):
    """One section of a card's body, by the heading the pour wrote above it."""
    head = HEADINGS.get(name, name)
    found = re.search(r"^##\s+%s\s*$(.*?)(?=^##\s|\Z)" % re.escape(head),
                      description or "", re.M | re.S)
    return found.group(1).strip() if found else ""


def kind_of(card):
    """What a card is: a job, something filed in passing, or a work item — or a
    step, which the board writes for itself and answers for in cor-tg56."""
    labels = card.get("labels") or []
    if any(lab.startswith("step:") for lab in labels):
        return "step"
    return "job" if "job" in labels else ("find" if "find" in labels else "item")


def faults(card, words=None):
    """Every bar this whole card is below, as {section: the rewrite it earns}.

    The same bars the pour runs, read off a card already standing — which is what
    makes "the board is at the bar" a run rather than a reading. `words` is
    `plain.problems`, and optional: a title answers to the word list only when the
    caller could load it.
    """
    kind = kind_of(card)
    if kind == "step":
        return {}
    body, meta = card.get("description") or "", card.get("metadata") or {}
    title = card.get("title") or ""
    found = words(title) if words else []
    out = {"title": "in the words of whoever built the thing: " + "; ".join(found)} \
        if found else {}
    if kind == "job":
        out.update(_found({
            "what": what_is_wrong(part(body, "what") or title),
            "evidence": ("" if len(part(body, "evidence")) >= 20 else
                         "Evidence it is real must say what makes this real today: the "
                         "check that went red and its number, the image, or the "
                         "manager's words."),
            "done": finish_line(meta.get("done") or card.get("acceptance_criteria")),
            "not_in": left_out(part(body, "not_in")),
        }))
    elif kind == "find":
        out.update(_found({"what": what_is_wrong(title),
                           "where": where_it_is(part(body, "where"))}))
    else:
        out.update(_found({"done": finish_line(card.get("acceptance_criteria"),
                                               "This work item's second half")}))
    return out


def _found(bars):
    return {name: said for name, said in bars.items() if said}
