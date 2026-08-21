"""How far two stretches of code stay the same once small gaps are allowed.

Comparing position against position only finds copies that differ by
substitution. The drift this exists to catch is more often a line PRESENT in one
copy and absent in the other — a guard added to one and forgotten on the rest —
which shifts everything after it and ends a positional comparison dead. So a
break is crossed by skipping a few tokens on either side and confirming both
streams are back in step.

Words that differ at a position where the shape matches are handed back rather
than counted: one copy of a routine written for a different quantity renames
things all the way through, and that is not drift. Which of those renames are
consistent is decided in `scripts/quality/drift.py`, where the whole run is in
view.
"""
from __future__ import annotations

# One whole line of this code, at the 99th percentile, so a break can cross a line
# that is present in one copy and absent in the other — the fault this exists for.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
SKIP = 12

# Where the count of copies actually found peaks. Shorter and any two closing
# brackets pass for a resynchronisation, which stitches unrelated text together and
# ruins the run it lands in; longer and real ones are turned away.
# [SOURCED] docs/code-quality.md#2-copies-a-change-may-not-pull-apart
CONFIRM = 16


def _resync(a: tuple, i: int, b: tuple, j: int,
            skip: int, confirm: int) -> tuple[int, int] | None:
    """The smallest skip on each side that puts the two streams back in step."""
    for total in range(1, 2 * skip + 1):
        for ga in range(max(0, total - skip), min(total, skip) + 1):
            gb = total - ga
            if i + ga + confirm > len(a) or j + gb + confirm > len(b):
                continue
            if a[i + ga:i + ga + confirm] == b[j + gb:j + gb + confirm]:
                return ga, gb
    return None


def forward(shape_a: tuple, word_a: tuple, i: int,
            shape_b: tuple, word_b: tuple, j: int,
            budget: int, skip: int = SKIP,
            confirm: int = CONFIRM) -> tuple[int, int, int, list[tuple[str, str]]]:
    """Walk forward from i, j: (tokens of a, tokens of b, tokens skipped, word swaps)."""
    da = db = gaps = 0
    swaps: list[tuple[str, str]] = []
    while True:
        while (i + da < len(shape_a) and j + db < len(shape_b)
               and shape_a[i + da] == shape_b[j + db]):
            if word_a[i + da] != word_b[j + db]:
                swaps.append((word_a[i + da], word_b[j + db]))
            da += 1
            db += 1
        if gaps >= budget or i + da >= len(shape_a) or j + db >= len(shape_b):
            break
        jump = _resync(shape_a, i + da, shape_b, j + db, skip, confirm)
        if jump is None:
            break
        ga, gb = jump
        gaps += max(ga, gb)
        da += ga
        db += gb
    return da, db, gaps, swaps


def around(shape_a: tuple, word_a: tuple, i: int,
           shape_b: tuple, word_b: tuple, j: int,
           budget: int, skip: int = SKIP, confirm: int = CONFIRM
           ) -> tuple[int, int, int, int, int, list[tuple[str, str]]]:
    """The whole run through i, j: starts, lengths in each, tokens skipped, swaps."""
    ra, rb, back, back_swaps = forward(shape_a[:i][::-1], word_a[:i][::-1], 0,
                                       shape_b[:j][::-1], word_b[:j][::-1], 0,
                                       budget, skip, confirm)
    fa, fb, fwd, fwd_swaps = forward(shape_a, word_a, i, shape_b, word_b, j,
                                     budget - back, skip, confirm)
    return (i - ra, j - rb, ra + fa, rb + fb, back + fwd, back_swaps + fwd_swaps)
