#!/usr/bin/env python3
"""Keep both providers pointed at the one canonical Atelier workflow."""

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
AGENTS = (ROOT / "AGENTS.md").read_text()
CLAUDE = (ROOT / "CLAUDE.md").read_text()
POLICY = (ROOT / "ATELIER_WORKFLOW.md").read_text().strip()
START = "<!-- BEGIN ATELIER WORKFLOW -->"
END = "<!-- END ATELIER WORKFLOW -->"


def fail(message: str) -> None:
    print(f"agent workflow: {message}", file=sys.stderr)
    raise SystemExit(1)


expected = ("## Atelier workflow (managed)\n\nBefore doing any work, read and "
            "follow [ATELIER_WORKFLOW.md](ATELIER_WORKFLOW.md).")
for name, provider in (("AGENTS.md", AGENTS), ("CLAUDE.md", CLAUDE)):
    if provider.count(START) != 1 or provider.count(END) != 1:
        fail(f"managed block markers must each appear once in {name}")
    managed = provider.split(START, 1)[1].split(END, 1)[0].strip()
    if managed != expected:
        fail(f"the managed block in {name} must require reading ATELIER_WORKFLOW.md")
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
