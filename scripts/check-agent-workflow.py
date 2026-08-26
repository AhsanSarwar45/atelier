#!/usr/bin/env python3
"""Keep both providers on the one canonical Atelier workflow."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
AGENTS = (ROOT / "AGENTS.md").read_text()
CLAUDE = (ROOT / "CLAUDE.md").read_text()
POLICY = (ROOT / "machinery" / "workflow-policy.md").read_text().strip()
START = "<!-- BEGIN ATELIER WORKFLOW -->"
END = "<!-- END ATELIER WORKFLOW -->"


def fail(message: str) -> None:
    print(f"agent workflow: {message}", file=sys.stderr)
    raise SystemExit(1)


if AGENTS != CLAUDE:
    fail("AGENTS.md and CLAUDE.md must be byte-identical")

if AGENTS.count(START) != 1 or AGENTS.count(END) != 1:
    fail("managed block markers must each appear once in both provider files")

managed = AGENTS.split(START, 1)[1].split(END, 1)[0].strip()
expected = f"## Atelier workflow (managed)\n\n{POLICY}"
if managed != expected:
    fail("the managed provider block does not match machinery/workflow-policy.md")
required_once = (
    "machinery/board/job new",
    "git -C . worktree add worktrees/<job-id> -b <job-id>",
    "bd update <work-id> --claim",
    "machinery/board/land <card-id>",
    "machinery/checks <checks-id>",
)
for command in required_once:
    count = managed.count(command)
    if count != 1:
        fail(f"{command!r} appears {count} times, expected once")

for forbidden in ("bd create ", "bd close "):
    if forbidden in managed:
        fail(f"competing code-work path {forbidden!r} is present")

print("agent workflow: 0 failures")
