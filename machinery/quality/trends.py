"""Counts that are reported and never gate.

Size is here rather than among the rules on purpose: published work and this tree
agree that length on its own says nothing about whether code is good, and the
file that proves it here is a 3,793-line one holding a single concern
(`docs/code-quality.md`). A count is context for a number that does gate, not a
verdict of its own.
"""
from __future__ import annotations

from collections import Counter

from .registry import Result, Scope, measure


@measure("size", "How much source there is", gates=False)
def size(scope: Scope) -> Result:
    corpus = scope.corpus
    files: Counter[str] = Counter()
    lines: Counter[str] = Counter()
    toks: Counter[str] = Counter()
    per_crate_lines: Counter[str] = Counter()
    widest: list[tuple[int, str]] = []

    for src in corpus.files:
        text = src.text()
        n = text.count("\n") + 1
        files[src.lang] += 1
        lines[src.lang] += n
        per_crate_lines[src.crate] += n
        toks[src.lang] += sum(1 for _ in src.tokens())
        widest.append((n, src.path))

    numbers = {}
    for lang in sorted(files):
        numbers[f"files.{lang}"] = files[lang]
        numbers[f"lines.{lang}"] = lines[lang]
        numbers[f"tokens.{lang}"] = toks[lang]
    for crate in sorted(per_crate_lines):
        numbers[f"lines.crate.{crate}"] = per_crate_lines[crate]
    numbers["files.all"] = sum(files.values())
    numbers["lines.all"] = sum(lines.values())
    numbers["tokens.all"] = sum(toks.values())

    widest.sort(reverse=True)
    return Result(
        numbers=numbers,
        listing=[f"{n:>6}  {path}" for n, path in widest[:10]],
    )
