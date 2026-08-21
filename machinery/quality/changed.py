"""Which lines this change touched, on whichever side of it the caller reasons about.

A rule that acts on a change needs to know what the change was, and comparing file
against file is too coarse: two copies can share a file with code nobody touched.
Line ranges come from git's own diff so the answer is the same one the commit will
carry.

Which side matters. A rule that reads relationships out of the tree as it stood
BEFORE the change has to ask in that tree's line numbers, or every answer is off by
however far the change shifted the file.
"""
from __future__ import annotations

import re
import subprocess
from collections import defaultdict

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")

WHOLE = (1, 1 << 30)

BEFORE, AFTER = "before", "after"


def _git(root: str, *args: str) -> str:
    out = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else ""


def base(root: str, against: str = "main") -> str | None:
    """The commit this branch left `against` at, which is what a change is measured from."""
    got = _git(root, "merge-base", "HEAD", against).strip()
    return got or None


def renames(root: str, since: str, to: str | None = None) -> dict[str, str]:
    """Old name -> new name, for every file this change moved, edited or not.

    Two ways, because git can only do the first: it pairs a deletion with an
    addition itself, but only among files it is tracking, and a file just written
    under a new name is not tracked yet. Once the rename is staged or committed the
    first way is the one that answers, so both are asked.
    """
    moved = _paired(root, since, to)
    if to is None:
        fresh = [row[3:].strip() for row in _git(root, "status", "--porcelain").splitlines()
                 if row.startswith("??")]
        moved.update(_by_content(root, since, fresh))
    return moved


def renamed(root: str, since: str, to: str | None = None) -> set[str]:
    """Both names of every file this change gave a new name to and nothing else.

    Only the untouched ones. A file renamed and edited in the same change still has
    its edit read, or every rule would look away from whatever was done under cover
    of the move.
    """
    moved = {old: new for old, new in renames(root, since, to).items()
             if _same_bytes(root, since, old, new, to)}
    return set(moved) | set(moved.values())


def _same_bytes(root: str, since: str, old: str, new: str, to: str | None) -> bool:
    was = _git(root, "rev-parse", f"{since}:{old}").strip()
    now = (_git(root, "rev-parse", f"{to}:{new}").strip() if to
           else _git(root, "hash-object", new).strip())
    return bool(was) and was == now


def _paired(root: str, since: str, to: str | None = None) -> dict[str, str]:
    """Old name -> new name, for every rename git paired on its own."""
    moved: dict[str, str] = {}
    for row in _git(root, "diff", "--name-status", "--find-renames", since,
                    *([to] if to else [])).splitlines():
        if row.startswith("R"):
            parts = row.split("\t")
            if len(parts) >= 3:
                moved[parts[1]] = parts[2]
    return moved


def _by_content(root: str, since: str, fresh: list[str]) -> dict[str, str]:
    """Old name -> new name for what git will not pair: the same bytes, moved.

    A file written under a new name is untracked, so git sees a deletion and an
    unrelated new file. Content settles it.
    """
    if not fresh:
        return {}
    was: dict[str, str] = {}
    for row in _git(root, "diff", "--name-status", "--find-renames", since).splitlines():
        if row.startswith("D\t"):
            path = row[2:].strip()
            blob = _git(root, "rev-parse", f"{since}:{path}").strip()
            if blob:
                was.setdefault(blob, path)
    moved: dict[str, str] = {}
    for path in fresh:
        blob = _git(root, "hash-object", path).strip()
        if blob in was:
            moved[was.pop(blob)] = path
    return moved


def lines(root: str, since: str, to: str | None = None,
          side: str = AFTER) -> dict[str, list[tuple[int, int]]]:
    """Path -> the line ranges this change reaches, numbered on `side`.

    A hunk that only adds lines occupies no lines on the earlier side, so it is
    reported as the seam between the two lines it sits between: a rule asking
    whether a change reached a stretch of the earlier tree has to be told yes.

    Untracked files appear only on the later side. There is no earlier version of
    one, so on the earlier side there is nothing for it to have touched.

    Renames are followed. A file given a new name has had nothing done to it, and
    read as a deletion it would look like one copy of a twinned pair being removed
    while the other stayed — a refusal for tidying up.
    """
    touched: dict[str, list[tuple[int, int]]] = defaultdict(list)

    fresh: list[str] = []
    if to is None:
        fresh = [row[3:].strip() for row in _git(root, "status", "--porcelain").splitlines()
                 if row.startswith("??")]
    moved = renamed(root, since, to)

    if side == AFTER:
        for path in fresh:
            if path not in moved:
                touched[path].append(WHOLE)

    want = _git(root, "diff", "--unified=0", "--find-renames", since,
                *([to] if to else []))
    path = None
    for row in want.splitlines():
        if side == BEFORE and row.startswith("--- a/"):
            path = row[6:]
        elif side == BEFORE and row.startswith("--- /dev/null"):
            path = None
        elif side == AFTER and row.startswith("+++ b/"):
            path = row[6:]
        elif side == AFTER and row.startswith("+++ /dev/null"):
            path = None
        elif path and path not in moved and (m := HUNK.match(row)):
            at, count = ((int(m.group(1)), m.group(2)) if side == BEFORE
                         else (int(m.group(3)), m.group(4)))
            n = 1 if count is None else int(count)
            touched[path].append((at, at + n - 1) if n else (at, at + 1))
    return dict(touched)


def shrunk(root: str, since: str, to: str | None = None) -> dict[str, list[tuple[int, int]]]:
    """Path -> earlier line ranges this change put back fewer lines than it took.

    An edit leaves a stretch the same length; taking a stretch out, or replacing it
    with a call to somewhere the code now lives once, does not. That is the
    difference between abandoning one copy of a pair and removing it.
    """
    out: dict[str, list[tuple[int, int]]] = defaultdict(list)
    path = None
    for row in _git(root, "diff", "--unified=0", "--find-renames", since,
                    *([to] if to else [])).splitlines():
        if row.startswith("--- a/"):
            path = row[6:]
        elif row.startswith("--- /dev/null"):
            path = None
        elif path and (m := HUNK.match(row)):
            at = int(m.group(1))
            took = 1 if m.group(2) is None else int(m.group(2))
            gave = 1 if m.group(4) is None else int(m.group(4))
            if took and gave < took:
                out[path].append((at, at + took - 1))
    return dict(out)


def covers(ranges: dict[str, list[tuple[int, int]]],
           path: str, first: int, last: int) -> bool:
    """Whether these ranges hold every line between `first` and `last`."""
    left = set(range(first, last + 1))
    for a, b in ranges.get(path, ()):
        left -= set(range(a, b + 1))
    return not left


def within(touched: dict[str, list[tuple[int, int]]],
           path: str, first: int, last: int) -> bool:
    """Whether this change reaches into `path` between `first` and `last`."""
    return any(a <= last and first <= b for a, b in touched.get(path, ()))
