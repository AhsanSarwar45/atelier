"""Which stretches of the tree are the same code, found without comparing everything
to everything.

Winnowing (Schleimer, Wilkerson and Aiken, *Winnowing: Local Algorithms for
Document Fingerprinting*, SIGMOD 2003) keeps roughly one hash per window and still
guarantees that any shared run of `gram + window - 1` tokens or longer leaves a
hash both copies agree on. That guarantee only ties the three to each other; which
run length is worth guaranteeing is a separate question, measured in
`scripts/quality/calibrate.py`.

Every number here is a default, not a fixed point: a threshold that cannot be
swept is a threshold nobody can derive.
"""
from __future__ import annotations

from collections import deque
from typing import Iterator

# One whole routine of this codebase, at the middle of the distribution, and well
# clear of the length below which text starts matching by accident.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
RUN = 100

# Where the count of copies actually found peaks, among the sizes that satisfy the
# guarantee above.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
GRAM = 25


def window_for(run: int, gram: int) -> int:
    """The winnowing window that makes `run` the shortest run guaranteed to be seen."""
    return max(1, run - gram + 1)


WINDOW = window_for(RUN, GRAM)

_BASE = 1_000_003
_MOD = (1 << 61) - 1


def _ids(shapes: list[str], pool: dict[str, int]) -> list[int]:
    out = []
    for s in shapes:
        i = pool.get(s)
        if i is None:
            i = pool[s] = len(pool) + 1
        out.append(i)
    return out


def grams(shapes: list[str], pool: dict[str, int], gram: int = GRAM) -> list[int]:
    """A hash per `gram`-token window, rolled rather than rebuilt."""
    ids = _ids(shapes, pool)
    n = len(ids)
    if n < gram:
        return []
    top = pow(_BASE, gram - 1, _MOD)
    h = 0
    for i in range(gram):
        h = (h * _BASE + ids[i]) % _MOD
    out = [h]
    for i in range(gram, n):
        h = ((h - ids[i - gram] * top) * _BASE + ids[i]) % _MOD
        out.append(h)
    return out


def winnow(hashes: list[int], window: int = WINDOW) -> Iterator[tuple[int, int]]:
    """(hash, token offset) for the minimum of each `window` of consecutive hashes.

    Ties take the rightmost, so two copies of the same text choose the same
    occurrence and their fingerprints match.
    """
    n = len(hashes)
    if n == 0:
        return
    if n < window:
        least = min(range(n), key=lambda i: (hashes[i], -i))
        yield hashes[least], least
        return
    live: deque[int] = deque()
    last = -1
    for i in range(n):
        # Popping on equal as well as greater leaves the RIGHTMOST of any tie.
        while live and hashes[live[-1]] >= hashes[i]:
            live.pop()
        live.append(i)
        start = i - window + 1
        if start < 0:
            continue
        while live[0] < start:
            live.popleft()
        if live[0] != last:
            last = live[0]
            yield hashes[last], last
