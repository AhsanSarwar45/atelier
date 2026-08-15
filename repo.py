#!/usr/bin/env python3
"""Where the checked-out copy a script is standing in begins.

Git marks a working copy under `worktrees/` with a `.git` FILE, and only the main
checkout with a `.git` directory, so a search for the directory walks straight past
the copy the caller is in and lands on the main tree — every gate then reads files
belonging to whoever is working there. The search is for either kind of entry.

The walk starts from this file, not from the current directory, so a gate reads the
copy it was installed in whatever directory it was invoked from.
"""
from __future__ import annotations

import os
import sys


def root(start: str | None = None) -> str:
    """The top of the copy `start` lives in; this file's own copy by default."""
    d = os.path.dirname(os.path.abspath(start or __file__))
    while not os.path.exists(os.path.join(d, ".git")):
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("not inside the repository")
        d = parent
    return d


if __name__ == "__main__":
    print(root())
