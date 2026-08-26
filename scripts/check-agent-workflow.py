#!/usr/bin/env python3
"""Keep AGENTS.md's managed workflow to one explicit repository path."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
TEXT = (ROOT / "AGENTS.md").read_text()
START = "<!-- BEGIN ATELIER WORKFLOW -->"
END = "<!-- END ATELIER WORKFLOW -->"


def fail(message: str) -> None:
    print(f"agent workflow: {message}", file=sys.stderr)
    raise SystemExit(1)


if TEXT.count(START) != 1 or TEXT.count(END) != 1:
    fail("managed block markers must each appear once")

managed = TEXT.split(START, 1)[1].split(END, 1)[0]
required_once = (
    "machinery/board/job new",
    "git -C /home/ahsan/dev/beads-web worktree add",
    "bd update <work-id> --claim",
    "machinery/board/land <card-id>",
)
for command in required_once:
    count = managed.count(command)
    if count != 1:
        fail(f"{command!r} appears {count} times, expected once")

for forbidden in ("bd create ", "bd close "):
    if forbidden in managed:
        fail(f"competing code-work path {forbidden!r} is present")

print("agent workflow: 0 failures")
