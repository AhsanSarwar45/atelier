#!/usr/bin/env python3
"""SubagentStop — what a helper says it did must be something it did.

The only other thing wired to a helper finishing keeps its caller's claim alive
(board-touch.py) and reads nothing the helper said, so a claim of verification
reached the session that sent it on trust alone.

Three refusals: a claim of verification with nothing run after the last change;
a return long enough to be a transcript rather than a verdict; a helper that
claimed a card and never named it. Fails open on anything it cannot read — a
gate that breaks must not cost a session its work.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "board"))
import board_common as bc  # noqa: E402

EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
RAN_TOOLS = ("Bash", "BashOutput", "Workflow", "Agent", "Task")

# Chars, then lines. The 99th percentile of each class over 2,532 measured
# returns, so only a dump is touched. [SOURCED] cor-5nxl.3
CAP_WROTE = (10_000, 120)
CAP_READ = (25_000, 200)

CLAIM = re.compile(
    r"\b(verified|re-?verified|tested|confirmed|validated|"
    r"(?:tests?|checks?|suite|build|it)\s+(?:all\s+)?pass(?:es|ed)?|"
    r"passes\s+(?:now|cleanly)|no\s+regressions?|all\s+green|works\s+now)\b",
    re.IGNORECASE)
NOT = re.compile(r"\b(not|never|cannot|can't|couldn't|could not|unable|"
                 r"without|no)\b", re.IGNORECASE)
CLAIMED = re.compile(r"\bbd\b[^|;&]*\bupdate\b[^|;&]*--claim\b")


class Refused(Exception):
    """One refusal, in one line."""


def block(reason):
    raise Refused(reason)


def transcript(data):
    """The finished helper's own transcript, by the path given or beside the
    session's own."""
    path = data.get("agent_transcript_path") or ""
    if path and os.path.exists(path):
        return path
    aid, main = data.get("agent_id") or "", data.get("transcript_path") or ""
    if not aid or not main:
        return ""
    beside = os.path.join(os.path.dirname(main),
                          os.path.basename(main).rsplit(".", 1)[0],
                          "subagents", "agent-%s.jsonl" % aid)
    return beside if os.path.exists(beside) else ""


def read(path, prefix):
    """What the helper did, in the order it did it: the ordinal of its last
    change, of the last thing it ran, the cards it claimed, and its last word."""
    last_edit = last_ran = -1
    claimed, said, step = [], "", 0
    for line in open(path, errors="ignore"):
        if '"assistant"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "assistant":
            continue
        for part in (entry.get("message") or {}).get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and (part.get("text") or "").strip():
                said = part["text"]
            if part.get("type") != "tool_use":
                continue
            step += 1
            name = part.get("name") or ""
            if name in EDIT_TOOLS:
                last_edit = step
            elif name in RAN_TOOLS:
                last_ran = step
                cmd = (part.get("input") or {}).get("command") or ""
                if CLAIMED.search(cmd):
                    claimed += re.findall(
                        r"\b%s-[0-9a-z.-]{2,16}\b" % re.escape(prefix), cmd)
    return last_edit, last_ran, claimed, said


def unproved(said):
    """A claim of verification, ignoring the ones that say it did not happen."""
    for hit in CLAIM.finditer(said):
        line = said[max(0, hit.start() - 90):hit.end()]
        if not NOT.search(line):
            return hit.group(0)
    return ""


def main():
    try:
        judge(json.load(sys.stdin))
    except Refused as no:
        print(json.dumps({"decision": "block", "reason": str(no)}))


def judge(data):
    if bc.reviewing():
        return
    path = transcript(data)
    if not path:
        return
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    last_edit, last_ran, claimed, said = read(path, bc.prefix(root))
    if not said:
        return

    if last_edit > 0 and last_ran < last_edit:
        claim = unproved(said)
        if claim:
            block('Says "%s" and nothing ran after its last change. Run what '
                  "proves it, or say what is unproved and why." % claim)

    cap = CAP_WROTE if last_edit > 0 else CAP_READ
    if len(said) > cap[0] or said.count("\n") + 1 > cap[1]:
        block("Answer is %d chars / %d lines, over %d / %d — that is a "
              "transcript, not a verdict. Return the conclusion."
              % (len(said), said.count("\n") + 1, cap[0], cap[1]))

    missing = [c for c in set(claimed) if c not in said]
    if missing and len(missing) == len(set(claimed)):
        block("Claimed %s and its answer names no card. Name the card and what "
              "it now stands on." % ", ".join(sorted(missing)))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # a broken gate must not cost a session its work
        pass
