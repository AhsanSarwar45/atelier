"""Copies of the same code that no longer say the same thing.

A copy written for a different quantity renames things all the way through, and
that is not drift: the two still agree. What predicts a fault is a copy changed
INCONSISTENTLY — a rename applied in some places and not others, or a line
present in one copy and absent in its twin. Only those are counted here. Why this
is gated and the sheer quantity of duplication is not:
`docs/code-quality.md#1-what-earns-the-right-to-refuse-a-change`.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache

from . import changed
from .align import CONFIRM, SKIP, around
from .corpus import Corpus
from .fingerprint import GRAM, RUN, grams, window_for, winnow
from .registry import Refusal, Result, Scope, measure

# Where alignments stop growing on their own: raising it further changes neither
# what is found nor what is watched, so it bounds cost and nothing else.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
BUDGET = 40

# How much of itself a pair must still agree on before an edit to one side is
# taken to be meant for the other. Below this the two share a skeleton rather than
# a meaning, and asking for them to be changed together is asking for noise.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart, and the
# twenty commits it was measured against are on cor-qrnj.8.
TWINS = 0.95

# The point past which letting a fingerprint be commoner finds nothing further. Set
# lower it hides real copies rather than saving work: at 40 it was hiding a third
# of them. How many are skipped is reported, so the cap is never silent.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
CROWD = 160


@dataclass(frozen=True)
class Side:
    path: str
    first: int      # first line of the copy
    last: int       # last line of it


@dataclass(frozen=True)
class Pair:
    left: Side
    right: Side
    tokens: int
    renamed: int    # word swaps that hold everywhere — the copy is parameterised
    broken: int     # word swaps that do not — the copy disagrees with itself
    gaps: int       # tokens present in one copy and absent in the other

    @property
    def apart(self) -> int:
        return self.broken + self.gaps

    @property
    def agreement(self) -> float:
        return 1.0 - self.apart / self.tokens

    @property
    def key(self) -> tuple:
        return (self.left.path, self.left.first, self.right.path, self.right.first)

    def __str__(self) -> str:
        return (f"{self.tokens:>5} tokens  {self.apart:>3} apart "
                f"({self.broken} inconsistent, {self.gaps} missing, {self.renamed} renamed)  "
                f"{self.left.path}:{self.left.first}-{self.left.last}"
                f"  <->  {self.right.path}:{self.right.first}-{self.right.last}")


def inconsistent(swaps: list[tuple[str, str]]) -> tuple[int, int]:
    """(swaps that hold everywhere, swaps that do not).

    A word swapped for one and only one other word, both ways round, is the same
    thing under another name. A word swapped for two different words in the same
    run means one of the places was edited and the others were not.
    """
    ahead: dict[str, set[str]] = defaultdict(set)
    aback: dict[str, set[str]] = defaultdict(set)
    for left, right in swaps:
        ahead[left].add(right)
        aback[right].add(left)
    broken = sum(1 for left, right in swaps
                 if len(ahead[left]) > 1 or len(aback[right]) > 1)
    return len(swaps) - broken, broken


class _Streams:
    """Token shapes, words and lines per file, kept for the files being compared."""

    def __init__(self, corpus: Corpus):
        self._files = {s.path: s for s in corpus.files}

    @lru_cache(maxsize=64)
    def _load(self, path: str) -> tuple[tuple[str, ...], tuple[str, ...], tuple[int, ...]]:
        toks = list(self._files[path].tokens())
        return (tuple(t.shape for t in toks),
                tuple(t.text for t in toks),
                tuple(t.line for t in toks))

    def shapes(self, path: str) -> tuple[str, ...]:
        return self._load(path)[0]

    def words(self, path: str) -> tuple[str, ...]:
        return self._load(path)[1]

    def lines(self, path: str) -> tuple[int, ...]:
        return self._load(path)[2]


def index(corpus: Corpus, run: int = RUN,
          gram: int = GRAM) -> tuple[dict[int, list[tuple[str, int]]], int]:
    """Fingerprint -> where it occurs, and how many token shapes were read."""
    pool: dict[str, int] = {}
    seen: dict[int, list[tuple[str, int]]] = defaultdict(list)
    window = window_for(run, gram)
    total = 0
    for src in corpus.files:
        shapes = [t.shape for t in src.tokens()]
        total += len(shapes)
        for h, at in winnow(grams(shapes, pool, gram), window):
            seen[h].append((src.path, at))
    return seen, total


def _side(streams: "_Streams", path: str, start: int, run: int) -> Side:
    lines = streams.lines(path)
    return Side(path, lines[start], lines[min(start + run, len(lines)) - 1])


def pairs(corpus: Corpus, budget: int = BUDGET, run: int = RUN, gram: int = GRAM,
          skip: int = SKIP, confirm: int = CONFIRM, crowd: int = CROWD,
          least_apart: int = 1) -> tuple[list[Pair], dict[str, int]]:
    """Every pair of copies at least `least_apart` tokens apart, most alike first.

    Reporting wants the ones that have already pulled apart, so it asks for at least
    one token of disagreement. A rule guarding against a copy being edited alone
    wants the opposite end: a pair still word for word the same is the strongest
    case there is, and asking for disagreement is asking it to look away.
    """
    seen, tokens = index(corpus, run, gram)
    streams = _Streams(corpus)
    crowded = 0
    found: dict[tuple, Pair] = {}

    for spots in seen.values():
        if len(spots) < 2:
            continue
        if len(spots) > crowd:
            crowded += 1
            continue
        for x in range(len(spots)):
            for y in range(x + 1, len(spots)):
                (pa, ia), (pb, ib) = spots[x], spots[y]
                sa, sb = streams.shapes(pa), streams.shapes(pb)
                if ia >= len(sa) or ib >= len(sb):
                    continue
                wa, wb = streams.words(pa), streams.words(pb)
                start_a, start_b, run_a, run_b, gaps, swaps = around(
                    sa, wa, ia, sb, wb, ib, budget, skip, confirm)
                if run_a < run:
                    continue
                # One stretch of a file matched against itself is the window sliding
                # over its own text, not a copy.
                if pa == pb and abs(start_a - start_b) < run_a:
                    continue
                renamed, broken = inconsistent(swaps)
                if broken + gaps < least_apart:
                    continue
                one = _side(streams, pa, start_a, run_a)
                two = _side(streams, pb, start_b, run_b)
                left, right = ((one, two) if (one.path, one.first) <= (two.path, two.first)
                               else (two, one))
                made = Pair(left, right, run_a, renamed, broken, gaps)
                if made.key not in found or found[made.key].tokens < run_a:
                    found[made.key] = made

    # Worst first means most nearly identical first, not longest first. A long copy
    # that disagrees in one place is someone editing one of the two; a long copy
    # that disagrees in fifty is two routines that share a skeleton.
    ranked = sorted(_maximal(found.values()), key=lambda p: (p.apart / p.tokens, -p.tokens))
    return ranked, {"tokens": tokens, "crowded": crowded}


def _maximal(found) -> list[Pair]:
    """One reading of each copy, the longest, in place of every alignment of it.

    A fingerprint lands at every offset a stretch allows, so one copy arrives as a
    dozen alignments of itself, each slightly shorter and slightly shifted. Together
    they are noise — and worse than noise for a rule about what a change touched,
    because a shifted alignment can begin after the line that was edited and so read
    as a copy nobody has touched.
    """
    inside: dict[tuple[str, str], list[Pair]] = defaultdict(list)
    for pair in sorted(found, key=lambda p: -p.tokens):
        kept = inside[(pair.left.path, pair.right.path)]
        if any(k.left.first <= pair.left.first and pair.left.last <= k.left.last
               and k.right.first <= pair.right.first and pair.right.last <= k.right.last
               for k in kept):
            continue
        kept.append(pair)
    return [p for kept in inside.values() for p in kept]


@measure("drift", "Copies that no longer say the same thing", gates=False)
def drift(scope: Scope) -> Result:
    ranked, counted = pairs(scope.corpus)
    return Result(
        numbers={
            "pairs": len(ranked),
            "fingerprints.too.common.to.pair": counted["crowded"],
        },
        listing=[str(p) for p in ranked[:20]],
    )


def _still_there(scope: Scope, side: Side, gone: dict) -> bool:
    """Whether that copy is still in the tree, as against having been taken out.

    Removing one of two copies, or lifting its body somewhere they can share, is the
    ordinary way to fix duplication — and read as an edit it looks exactly like
    abandoning a twin. What separates them is length: an edit leaves the stretch as
    long as it was, and taking it out does not.
    """
    if scope.corpus.get(side.path) is None:
        return False
    return not changed.covers(gone, side.path, side.first, side.last)


@measure("twin", "Copies edited on one side and not the other", gates=True)
def twin(scope: Scope) -> Result:
    """Refuse a change that reaches into one copy of a pair and not into its twin.

    The pairs are read from the tree as it stood BEFORE the change. A pair read
    from the tree afterwards would be missing exactly the ones an edit pushed
    apart, which are the ones this exists to catch.
    """
    # These two say something about a change. Asked of a tree with no change to
    # read, they have no answer, and answering zero would read as a fall to zero.
    if not scope.since or scope.earlier is None:
        return Result()

    touched = changed.lines(scope.root, scope.since, scope.until, side=changed.BEFORE)
    if not touched:
        return Result(numbers={"pairs.watched": 0, "edited.on.one.side": 0})

    gone = changed.shrunk(scope.root, scope.since, scope.until)
    found, _ = pairs(scope.earlier, least_apart=0)
    watched = [p for p in found if p.agreement >= TWINS]

    refused = []
    for pair in watched:
        here = changed.within(touched, pair.left.path, pair.left.first, pair.left.last)
        there = changed.within(touched, pair.right.path, pair.right.first, pair.right.last)
        if here == there:
            continue
        edited, left_alone = (pair.left, pair.right) if here else (pair.right, pair.left)
        if not _still_there(scope, edited, gone):
            continue
        refused.append(Refusal(
            f"{edited.path}:{edited.first}-{edited.last}",
            f"is {pair.tokens} tokens of the same code as "
            f"{left_alone.path}:{left_alone.first}-{left_alone.last}, "
            f"which this change does not touch",
        ))

    return Result(
        numbers={"pairs.watched": len(watched), "edited.on.one.side": len(refused)},
        refusals=refused,
    )
