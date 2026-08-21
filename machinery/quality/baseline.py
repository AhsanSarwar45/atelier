"""An earlier point of the tree, laid out somewhere else so this one is not disturbed.

Switching branches to compare would destroy whatever every other working copy of
this repository has in flight, so an earlier point is never checked out: it is
unpacked out of git's own object store into a directory of its own, read, and
thrown away.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from .corpus import ROOTS


def resolve(root: str, ref: str) -> str:
    """The full name of `ref`, so a run says which commit it read."""
    out = subprocess.run(["git", "-C", root, "rev-parse", "--verify", f"{ref}^{{commit}}"],
                         capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f"{ref} is not a commit in this repository")
    return out.stdout.strip()


class Extracted:
    """`ref` unpacked into a directory of its own, removed on the way out."""

    def __init__(self, root: str, ref: str):
        self.root = root
        self.sha = resolve(root, ref)
        self.where: str | None = None

    def __enter__(self) -> str:
        self.where = tempfile.mkdtemp(prefix="quality-")
        archive = subprocess.Popen(
            ["git", "-C", self.root, "archive", self.sha] + list(ROOTS),
            stdout=subprocess.PIPE,
        )
        untar = subprocess.run(["tar", "-x", "-C", self.where], stdin=archive.stdout)
        archive.stdout.close()
        if archive.wait() or untar.returncode:
            raise SystemExit(f"could not lay out {self.sha[:8]} to read it")
        return self.where

    def __exit__(self, *_):
        if self.where and os.path.isdir(self.where):
            shutil.rmtree(self.where, ignore_errors=True)
        return False
