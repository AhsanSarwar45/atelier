#!/usr/bin/env python3
"""Two gates on every visible string in a report.

`jargon` — a word only a builder of the thing would use. The test is physical:
a noun must be something the manager can see, click, buy or feel. Enforced from
`phrasebook.json` plus the shapes code leaves behind (paths, run-together names,
call syntax). A term survives only if the page glosses it inline.

`markup` — the look is not the agent's to write, so a string carrying tags,
colours or sizes is refused before it reaches the page.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

PHRASEBOOK = json.loads((Path(__file__).with_name("phrasebook.json")).read_text(encoding="utf-8"))
BANNED = {k: v for k, v in PHRASEBOOK.items() if not k.startswith("_")}

CODE_EXT = r"(rs|py|wgsl|toml|json|ini|md|sh|lock|kn5|dds|ipynb|yml|yaml|cfg)"

SHAPES = [
    (re.compile(r"\b[\w.-]+/[\w./-]+\.\w{1,6}\b"), "a file path"),
    (re.compile(rf"\b[\w-]+\.{CODE_EXT}\b", re.I), "a file name"),
    (re.compile(r"\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b"), "a run-together code name"),
    (re.compile(r"\b[a-z]+[A-Z][A-Za-z]*\b"), "a run-together code name"),
    (re.compile(r"\b[A-Z][a-z]+[A-Z][A-Za-z]*\b"), "a run-together code name"),
    (re.compile(r"\b[A-Z][A-Z0-9_]{2,}\b"), "shouted initials"),
    (re.compile(r"\w+\(\)"), "call syntax"),
    (re.compile(r"`[^`]+`"), "quoted code"),
    (re.compile(r"\b(fn|impl|pub|let mut|struct|enum)\b"), "source keywords"),
]

# Ordinary words that the shape rules would otherwise trip over.
SHAPE_EXEMPT = {"I", "A", "AC", "OK", "TODO", "FYI", "PC", "VR", "US", "UK", "AM", "PM"}

MARKUP = [
    (re.compile(r"<\s*/?\s*[a-zA-Z][\w-]*[\s>/]"), "an HTML tag"),
    (re.compile(r"\bstyle\s*=", re.I), "an inline style"),
    (re.compile(r"#[0-9A-Fa-f]{3,8}\b"), "a colour"),
    (re.compile(r"\b(rgb|rgba|hsl|var)\s*\(", re.I), "a colour"),
    (re.compile(r"\bfont-(family|size|weight)\b", re.I), "a typeface choice"),
    (re.compile(r"\b\d+(px|rem|em)\b"), "a size"),
    (re.compile(r"&[a-z]+;|&#\d+;", re.I), "an HTML escape"),
]


def markup(text: str) -> list[str]:
    """What in this string tries to set the look."""
    return [f"{label} ({m.group(0)!r})" for rx, label in MARKUP for m in [rx.search(text)] if m]


def jargon(text: str, glossed: set[str]) -> list[str]:
    """Every term the manager would have to decode, with what to say instead."""
    hits, seen = [], set()
    lowered = {g.lower() for g in glossed}

    for term, plain in BANNED.items():
        if term in lowered:
            continue
        if re.search(rf"\b{re.escape(term)}\b", text, re.I) and term not in seen:
            seen.add(term)
            hits.append(f"{term!r} — say {plain!r}")

    for rx, label in SHAPES:
        for m in rx.finditer(text):
            word = m.group(0)
            if word in SHAPE_EXEMPT or word.lower() in lowered or word.lower() in seen:
                continue
            seen.add(word.lower())
            hits.append(f"{word!r} is {label} — name what it does, not what it is called")

    return hits
