#!/usr/bin/env python3
"""Voice check — the instruction files must be written the way we want agents to write.

An agent copies the register of its own prompt. Measured over 68 sessions and 1294
chat messages, agent replies carried 18.2 em-dashes per 1000 words against 3.2 in
the manager's own typing, and every file that teaches the voice sat between 7 and 24.
So the files are what this checks: cap the markers there and the output follows.

    python3 machinery/voice-check.py              the instruction files, exit 1 on any failure
    python3 machinery/voice-check.py --chat 12    what the last 12 sessions actually wrote
"""
import argparse
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
    "machinery/hooks/board-prime.py",
    "reporting/README.md",
]

EM_DASH_PER_1K = 4.0     # the manager's own writing runs at 3.2
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


def prose(path):
    """The words a reader takes as an example. For Python, only the docstrings."""
    text = open(path, encoding="utf-8", errors="replace").read()
    if path.endswith(".py"):
        text = "\n".join(re.findall(r'"""(.*?)"""', text, re.S))
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)   # frontmatter
    text = re.sub(r"```.*?```", " ", text, flags=re.S)          # fenced code
    text = re.sub(r"`[^`\n]*`", " ", text)                     # inline code
    return text


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
        for m in re.finditer(pattern, text):
            line = text[:m.start()].count("\n") + 1
            snippet = text[max(0, m.start() - 30):m.end() + 30].replace("\n", " ").strip()
            bad.append("%s:%d %s\n      ...%s...\n      instead of: %s\n      write:      %s"
                       % (name, line, label, snippet, was, better))
    return bad


def chat(limit):
    """What the sessions actually wrote to the manager, newest first."""
    # Transcripts are filed under the main checkout, never under a worktree.
    main = re.sub(r"/worktrees/[^/]+$", "", ROOT)
    home = os.path.expanduser("~/.claude/projects/" + main.replace("/", "-"))
    paths = sorted(glob.glob(os.path.join(home, "*.jsonl")),
                   key=os.path.getmtime, reverse=True)[:limit]
    if not paths:
        print("no session transcripts under %s" % home)
        return
    parts = []
    for p in paths:
        for line in open(p, encoding="utf-8", errors="replace"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("isSidechain") or d.get("type") != "assistant":
                continue
            for b in d.get("message", {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "text":
                    t = (b.get("text") or "").strip()
                    if t and not t.startswith("You've hit"):
                        parts.append(t)
    text = "\n".join(parts)
    words = len(text.split()) or 1
    print("%d sessions, %d replies, %d words" % (len(paths), len(parts), words))
    print("  em-dashes per 1000 words: %.1f   (cap %.0f)" % (text.count("—") * 1000 / words, EM_DASH_PER_1K))
    print("  semicolons per 1000 words: %.1f  (cap %.0f)" % (text.count(";") * 1000 / words, SEMICOLON_PER_1K))
    for label, pattern, _, _ in BANNED:
        n = len(re.findall(pattern, text))
        if n:
            print("  %-34s %d" % (label, n))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--chat", type=int, metavar="N", nargs="?", const=12,
                    help="report what the last N sessions wrote, and check nothing")
    args = ap.parse_args()

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
