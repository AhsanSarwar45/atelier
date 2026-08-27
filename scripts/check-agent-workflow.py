#!/usr/bin/env python3
"""Keep the installed Beads skill canonical."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
POLICY = (ROOT / "machinery" / "skills" / "beads" / "SKILL.md").read_text().strip()


def fail(message: str) -> None:
    print(f"agent workflow: {message}", file=sys.stderr)
    raise SystemExit(1)


required_once = (
    "machinery/board/job new",
    "git -C . worktree add worktrees/<job-id> -b <job-id>",
    "bd update <work-id> --claim",
    "machinery/board/land <card-id>",
    "machinery/checks <checks-id>",
)
for command in required_once:
    count = POLICY.count(command)
    if count != 1:
        fail(f"{command!r} appears {count} times, expected once")

for forbidden in ("bd create ", "bd close "):
    if forbidden in POLICY:
        fail(f"competing code-work path {forbidden!r} is present")

if "scripts/workbench-e2e.sh" in POLICY:
    fail("the shared workflow contains this repository's isolated app instructions")

print("agent workflow: 0 failures")
