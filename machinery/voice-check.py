#!/usr/bin/env python3
"""Voice check — the instruction files must be written the way we want agents to write.

An agent copies the register of its own prompt. Measured over 68 sessions, 637
agent replies carried 14.2 em-dashes per 1000 words across 54,649 words, against
1.3 in the 3,914 words the manager typed back over 135 turns. Every file that
teaches the voice sat above the same line. So the files are what this checks: cap
the markers there and the output follows.

    python3 machinery/voice-check.py              the instruction files, exit 1 on any failure
    python3 machinery/voice-check.py --selftest   put each fault back, and watch every rule go red
    python3 machinery/voice-check.py --chat 12    what the last 12 sessions actually wrote
"""
import argparse
import ast
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))

# Files whose prose an agent reads as an example of how to write.
TARGETS = [
    "CLAUDE.md",
    ".claude/output-styles/*.md",
    ".claude/agents/*.md",
    ".claude/skills/*/SKILL.md",
    ".claude/commands/*.md",
    "machinery/hooks/*.py",
    "reporting/README.md",
]

EM_DASH_PER_1K = 4.0     # the manager's own writing runs at 1.3 (see --chat)
SEMICOLON_PER_1K = 5.0

# Sentence shapes that make a fact sound like an aphorism. Each one costs the
# reader a decode step and carries no information the plain form does not.
BANNED = [
    ("'X, and it is Y'",
     r",\s+and\s+(?:it|that|this|they|nothing|nobody|none)\s+(?:is|was|are|were|has|have)\b",
     "The claim holds for five minutes, and it is refreshed by your own activity.",
     "A claim lasts five minutes. Your own activity refreshes it."),
    ("'not X, but Y' inversion",
     r"\bnot\s+[^.,;\n]{1,60},\s*(?:but|it is|that is)\b",
     "It is not a warning, but a refusal.",
     "It refuses. It does not warn."),
    ("'there is no third way'",
     r"\bthere is no (?:second|third|fourth|other)\b",
     "There is no third way.",
     "Those are the only two options."),
    ("aphoristic 'which is what/why/how'",
     r"\bwhich is (?:what|why|how)\b",
     "...nobody is building it, which is what that column means.",
     "...nobody is building it. That is what the column means."),
    ("'the one thing'",
     r"\bthe one thing\b",
     "It spends the one thing he cannot delegate.",
     "It spends his attention."),
    ("tautology 'A X is a X only if'",
     r"\bA[n]? (\w+) is a[n]? \1 only\b",
     "A cause is a cause only if switching it off removes the defect.",
     "You have found the cause only if switching it off removes the defect."),
    ("'the whole of it'",
     r"\bthe whole of it\b",
     "One command does the whole of it.",
     "One command does all four steps."),
    ("progress stub 'Now the ...'",
     r"(?m)^\s*(?:[-*]\s*)?Now the\b",
     "Now the two-clock split.",
     "Next I split the two clocks apart, so the timer shows the current step."),
]


# "**Term** — definition" at the head of a line is a list format, doing the job a
# colon does. The dash this checks for is the one that restates a clause inside a
# sentence, so only a real label is exempt: a bold term, a heading's name, or a
# one-word list entry. An earlier spelling let any short run of words count as a
# label, which exempted every sentence whose wrapping happened to put a dash near
# the start of a line, and passed files nobody had rewritten (bw-ld63.8).
LABEL_DASH = re.compile(r"""^\s*(?:\|\s*)?(?:
      (?:[-*+]\s+|\d+[.)]\s+)?\*\*[^*\n]{1,60}\*\*[:,]?\s*—   # **Term** — what it means
    | \#+\s+[^\s—][^—\n]{0,45}—                                # # name — what it is
    | [-*+]\s+(?:[^\s—*][^\s—]{0,45})?[:,]?\s*—                 # - term — what it means
)""", re.X)


def drop_label_dashes(text):
    out = []
    for line in text.split("\n"):
        if LABEL_DASH.match(line):
            line = line.replace("—", "", 1)
        out.append(line)
    return "\n".join(out)


# A pattern, a key or a fragment of shell is not English and must not be weighed
# as if it were.
CODEY = re.compile(r"\\[sbdwSBDW]|\(\?|^\^|^[A-Za-z_.]+$|^--|^/")


def spoken(path):
    """The strings a hook prints into an agent's tool result.

    This is the channel that teaches the voice: a gate's refusal arrives in the
    same place a reply does, every session, and an agent copies it. A docstring
    inside the same file is a note to whoever edits the file, read no more often
    than any other source in the repo, so it is left out.
    """
    try:
        tree = ast.parse(open(path, encoding="utf-8", errors="replace").read())
    except SyntaxError:
        return ""
    docs = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", None) or []
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                docs.add(id(body[0].value))
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docs:
            continue
        v = node.value.strip()
        if len(v.split()) < 4 or CODEY.search(v):
            continue
        out.append(v)
    return "\n".join(out)


def prose(path):
    """The words a reader takes as an example. For Python, what it says to an agent."""
    text = open(path, encoding="utf-8", errors="replace").read()
    if path.endswith(".py"):
        text = spoken(path)
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)   # frontmatter
    text = re.sub(r"```.*?```", " ", text, flags=re.S)          # fenced code
    # A block another tool generates and stamps with its own hash is not ours to
    # write, and an edit inside it is overwritten the next time that tool runs.
    text = re.sub(r"<!-- BEGIN [A-Z ]+?v:.*?<!-- END [A-Z ]+? -->", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)                     # inline code
    return drop_label_dashes(text)


def files():
    out = []
    for pattern in TARGETS:
        for p in sorted(glob.glob(os.path.join(ROOT, pattern))):
            if os.path.isfile(p) and not os.path.islink(p):
                out.append(p)
    return out


def check_text(name, text):
    """Return a list of failure lines."""
    words = len(text.split())
    if words < 60:
        return []
    bad = []
    for label, per1k, cap in (("em-dashes", text.count("—") * 1000 / words, EM_DASH_PER_1K),
                              ("semicolons", text.count(";") * 1000 / words, SEMICOLON_PER_1K)):
        if per1k > cap:
            bad.append("%s: %.1f %s per 1000 words, cap is %.0f" % (name, per1k, label, cap))
    for label, pattern, was, better in BANNED:
        for m in re.finditer(pattern, text, re.I):
            line = text[:m.start()].count("\n") + 1
            snippet = text[max(0, m.start() - 30):m.end() + 30].replace("\n", " ").strip()
            bad.append("%s:%d %s\n      ...%s...\n      instead of: %s\n      write:      %s"
                       % (name, line, label, snippet, was, better))
    return bad


def turns(paths, side):
    """The replies an agent wrote, or the turns the manager actually typed.

    A session's record holds far more user-role entries than the manager ever
    wrote: gate refusals, hook text and pasted output all arrive in that role. The
    record marks the difference itself, so the manager's side counts only entries
    it stamps as typed by a human, and an earlier count that did not was reading
    our own gate messages back as his prose (bw-ld63.13).
    """
    out = []
    for p in paths:
        for line in open(p, encoding="utf-8", errors="replace"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("isSidechain"):
                continue
            if side == "agent":
                if d.get("type") != "assistant":
                    continue
                for b in d.get("message", {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "text":
                        t = (b.get("text") or "").strip()
                        if t and not t.startswith("You've hit"):
                            out.append(t)
            else:
                if d.get("type") != "user" or (d.get("origin") or {}).get("kind") != "human":
                    continue
                c = d.get("message", {}).get("content")
                if isinstance(c, str) and c.strip():
                    out.append(c.strip())
    return out


def chat(limit):
    """What the sessions actually wrote, both sides, newest first."""
    # Transcripts are filed under the main checkout, never under a worktree.
    main = re.sub(r"/worktrees/[^/]+$", "", ROOT)
    home = os.path.expanduser("~/.claude/projects/" + main.replace("/", "-"))
    paths = sorted(glob.glob(os.path.join(home, "*.jsonl")),
                   key=os.path.getmtime, reverse=True)[:limit]
    if not paths:
        print("no session transcripts under %s" % home)
        return
    print("%d sessions" % len(paths))
    for side in ("agent", "manager"):
        parts = turns(paths, side)
        text = drop_label_dashes("\n".join(parts))
        words = len(text.split()) or 1
        print("  %-8s %5d turns, %6d words   em-dashes %.1f, semicolons %.1f per 1000 words"
              % (side, len(parts), words,
                 text.count("—") * 1000 / words, text.count(";") * 1000 / words))
        if side == "agent":
            for label, pattern, _, _ in BANNED:
                n = len(re.findall(pattern, text, re.I))
                if n:
                    print("             %-34s %d" % (label, n))


# The two halves of the label rule, each proved by the selftest: what a list format
# looks like, and what a sentence restating itself looks like when the line happens
# to break in front of it.
LABEL_EXEMPT = [
    "- **Term** — what it means",
    "1. **Step** — do the thing",
    "# name — what it is",
    "- code-reviewer — adversarial review with DEMO verification",
    "-   — a label whose term was inline code and got stripped",
]
LABEL_COUNTED = [
    "Absence never announces itself — you have to go looking for it deliberately.",
    "- Read the actual code — don't grep for keywords only",
    "Single binary — the frontend is embedded, so there is nothing to publish.",
    "isolation** — simultaneous contrast will shift it.",
]


def selftest():
    """Put every fault back and watch its own rule go red.

    A gate nobody has seen refuse is a gate nobody knows still works. Each shape
    below is fed its own bad example, which must fail, and its own rewrite, which
    must pass. Then the real style file is checked as it stands and again with one
    banned line put back on the end.
    """
    faults = []
    filler = "word " * 200
    for label, _, was, better in BANNED:
        if not check_text("case", filler + "\n" + was):
            faults.append("%s: the bad example passed" % label)
        if check_text("case", filler + "\n" + better):
            faults.append("%s: the rewrite it suggests fails its own check" % label)
    if not check_text("case", "A sentence and then a dash — a restatement. " * 30):
        faults.append("em-dash rate: a page of dashes passed")
    if not check_text("case", "A sentence and then a splice; a second clause. " * 30):
        faults.append("semicolon rate: a page of splices passed")

    for line in LABEL_EXEMPT:
        if "—" in drop_label_dashes(line):
            faults.append("label exemption: a list label was counted as prose: %s" % line)
    for line in LABEL_COUNTED:
        if "—" not in drop_label_dashes(line):
            faults.append("label exemption: a prose dash was let through as a label: %s" % line)

    # A hook teaches the voice through what it says to an agent, not through the
    # notes it keeps for whoever edits it.
    sample = os.path.join(ROOT, "machinery/hooks/picture-gate.py")
    said = spoken(sample)
    if "screen-check" not in said:
        faults.append("spoken(): a gate's refusal text was not read")
    if "Fails open" in said:
        faults.append("spoken(): a note to the editor was read as if an agent saw it")

    style = os.path.join(ROOT, ".claude/output-styles/manager.md")
    if not os.path.isfile(style):
        faults.append("the manager style file is not where this expects it")
    else:
        if check_text("manager.md", prose(style)):
            faults.append("the manager style file does not pass as it stands")
        if not check_text("manager.md", prose(style) + "\n" + BANNED[0][2] + "\n"):
            faults.append("the manager style file passed with a banned line put back")

    for f in faults:
        print("  " + f)
    print("voice-check --selftest: %d rules, %d faults"
          % (len(BANNED) + 5 + len(LABEL_EXEMPT) + len(LABEL_COUNTED), len(faults)))
    return 1 if faults else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true",
                    help="put each fault back and check every rule goes red")
    ap.add_argument("--chat", type=int, metavar="N", nargs="?", const=12,
                    help="report what the last N sessions wrote, and check nothing")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.chat:
        chat(args.chat)
        return 0

    checked = files()
    failures = []
    for p in checked:
        failures += check_text(os.path.relpath(p, ROOT), prose(p))

    for f in failures:
        print("  " + f)
    print("voice-check: %d files, %d failures" % (len(checked), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
