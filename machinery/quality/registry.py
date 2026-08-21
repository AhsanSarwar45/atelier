"""What a measure is, and the list of them a run walks.

A measure returns numbers and, if it gates, the places it refuses. The two are
kept apart on purpose: numbers are compared between two points in time, refusals
are about the tree in front of you.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from .corpus import Corpus

SITTING = re.compile(r":\d+(?:-\d+)?$")


@dataclass(frozen=True)
class Refusal:
    """One place a rule says no, in the words the run prints."""
    where: str      # path, or path:line
    says: str


def place(where: str) -> str:
    """Where a refusal is, without the lines it happens to sit on.

    Cutting at the first colon would do for a rule that names a file, and takes the
    name off a rule that names a module: `crate::part::piece` becomes the crate, and
    every fresh refusal anywhere in that crate then reads as one already standing.
    Only a trailing line or line range comes off, from each place a rule lists.
    """
    return "; ".join(SITTING.sub("", part) for part in where.split("; "))


@dataclass
class Result:
    numbers: dict[str, float] = field(default_factory=dict)
    refusals: list[Refusal] = field(default_factory=list)
    # Rows a measure wants printed but never compared — a ranked list, a top-20.
    listing: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Scope:
    """What a measure is allowed to look at.

    `earlier` is laid out once for the whole run and only while it is needed, so
    two rules asking what the tree looked like before this change do not each pay
    to unpack it.
    """
    corpus: Corpus
    root: str                   # the tree being read
    since: str | None = None    # the commit this change is measured against
    earlier: Corpus | None = None
    # Where the change ends. None is the working tree; a commit replays a change
    # already made, which is how a rule is asked what it would have said to the
    # history it claims never to fire on.
    until: str | None = None


@dataclass(frozen=True)
class Measure:
    id: str
    title: str
    gates: bool     # False means reported and never able to fail a run
    run: Callable[[Scope], Result]


MEASURES: list[Measure] = []


def measure(id: str, title: str, *, gates: bool):
    """Register a measure. Import order fixes the order a run reports them in."""
    def take(fn: Callable[[Scope], Result]) -> Callable[[Scope], Result]:
        MEASURES.append(Measure(id, title, gates, fn))
        return fn
    return take


def run_all(scope: Scope) -> dict[str, Result]:
    return {m.id: m.run(scope) for m in MEASURES}
