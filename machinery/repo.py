#!/usr/bin/env python3
"""Where the checked-out copy a script is standing in begins.

Git marks a separate working copy with a `.git` FILE, and only the main checkout
with a `.git` directory, so a search for the directory walks straight past the copy
the caller is in and lands on the main tree — every gate then reads files belonging
to whoever is working there. The search is for either kind of entry.

The walk starts from where the caller is standing, because this file is shared by
every project: a tool that walked up from its own path would measure the machinery
itself whichever project asked.
"""
from __future__ import annotations

import os
import sys


def root(start: str | None = None) -> str:
    """The top of the copy `start` lives in; the caller's own copy by default."""
    d = os.path.abspath(start) if start else os.getcwd()
    d = d if os.path.isdir(d) else os.path.dirname(d)
    while not os.path.exists(os.path.join(d, ".git")):
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("not inside the repository")
        d = parent
    return d


if __name__ == "__main__":
    print(root())
