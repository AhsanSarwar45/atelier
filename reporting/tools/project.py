#!/usr/bin/env python3
"""Which project a report belongs to.

A job is often done in a worktree, a second checkout whose directory is named
after the branch and deleted the day the job lands. A report outlives that, so
the name is taken from the main checkout — the shared git directory points at
it from inside any worktree.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def name(cwd: Path) -> str:
    """The project's name, the same from its main checkout or any worktree."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, cwd=cwd, timeout=10,
        )
    except OSError:
        return Path(cwd).name
    if out.returncode != 0 or not out.stdout.strip():
        return Path(cwd).name
    return Path(out.stdout.strip()).parent.name


if __name__ == "__main__":
    print(name(Path.cwd()))
