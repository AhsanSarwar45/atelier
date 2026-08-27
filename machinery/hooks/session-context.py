#!/usr/bin/env python3
"""SessionStart: inject Atelier capabilities and conditional Beads workflow."""
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
HOME = os.path.dirname(HERE)
sys.path.insert(0, HOME)
import project  # noqa: E402


def read_skill(name):
    where = os.path.join(HOME, "skills", name, "SKILL.md")
    try:
        with open(where, errors="replace") as source:
            text = source.read()
    except OSError:
        return ""
    # Frontmatter is discovery metadata, not session instruction content.
    if text.startswith("---\n"):
        _, marker, body = text[4:].partition("\n---\n")
        if marker:
            return body.strip()
    return text.strip()


def registered(cwd):
    """Whether cwd belongs to a registered repository, including a worktree."""
    if not cwd:
        return False
    here = os.path.realpath(cwd)
    identity = project.git_identity(here)
    for root in project.registry().values():
        if os.path.realpath(root) == here:
            return True
        if identity and project.git_identity(root) == identity:
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    parts = []
    # The workbench token is minted by Atelier and inherited by the provider
    # process. A generic terminal session has no claim to Atelier-only UI.
    if os.environ.get("ATELIER_WORKBENCH_TOKEN"):
        skill = read_skill("atelier")
        if skill:
            parts.append(skill)
    if registered(cwd):
        skill = read_skill("beads")
        if skill:
            parts.append(skill)
        parts.append("This session is in a Beads-registered project.")
    else:
        parts.append("This session is not in a Beads-registered project. Do not use Beads for its work.")
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n\n".join(parts),
    }}))


if __name__ == "__main__":
    main()
