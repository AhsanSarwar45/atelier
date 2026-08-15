"""The source a run measures: which files count, and how each one reads as tokens.

Text is read on demand and tokens are yielded rather than collected, because the
tree is around two million tokens and holding them all at once is a quarter of a
gigabyte no measure needs.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterator

# Not ours to measure: build output, vendored code, other people's working copies,
# git internals, caches.
SKIP_DIRS = {"target", "vendor", "worktrees", ".git", "node_modules", "__pycache__"}

# Where first-party source lives, and what counts as source in each place.
ROOTS = {
    "crates": (".rs", ".wgsl"),
    "scripts": (".py",),
}

LANG = {".rs": "rust", ".wgsl": "wgsl", ".py": "python"}

# Opens with the alternation bar: every lexer below ends on an alternative, and
# without it this whole tail reads as a continuation of that one.
_TAIL = r"""
  | (?P<number>\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[A-Za-z0-9_]*)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<punct>[^\s\w])
"""

# A lifetime and a character literal both open with a quote, so the character
# literal — which closes — is tried first; otherwise `&'a str … 'x'` reads as one
# string spanning the line and the shape of the code is lost.
_RUSTLIKE = r"""
    (?P<line>//[^\n]*)
  | (?P<block>/\*.*?\*/)
  | (?P<char>'(?:\\.|[^'\\\n])')
  | (?P<lifetime>'[A-Za-z_][A-Za-z0-9_]*)
  | (?P<string>"(?:\\.|[^"\\\n])*")
""" + _TAIL

_PYTHON = r"""
    (?P<line>\#[^\n]*)
  | (?P<string>\"\"\".*?\"\"\"|'''.*?'''
               |"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')
""" + _TAIL

LEXER = {
    "rust": re.compile(_RUSTLIKE, re.X | re.S),
    "wgsl": re.compile(_RUSTLIKE, re.X | re.S),
    "python": re.compile(_PYTHON, re.X | re.S),
}

DROPPED = ("line", "block")

# What a token collapses to when only the SHAPE of the code matters. Two blocks of
# the same shape are candidate copies; their identifiers are then what says whether
# the copies still agree.
SHAPE = {"ident": "I", "lifetime": "I", "number": "N", "string": "S", "char": "S"}


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    line: int

    @property
    def shape(self) -> str:
        return SHAPE.get(self.kind, self.text)


def tokens(text: str, lang: str) -> Iterator[Token]:
    """Every token of `text`, comments and whitespace dropped, in source order."""
    line, at = 1, 0
    for m in LEXER[lang].finditer(text):
        line += text.count("\n", at, m.start())
        at = m.start()
        if m.lastgroup in DROPPED:
            continue
        yield Token(m.lastgroup, m.group(), line)


@dataclass(frozen=True)
class Source:
    path: str   # relative to the tree being measured
    lang: str
    root: str   # absolute path of that tree

    @property
    def full(self) -> str:
        return os.path.join(self.root, self.path)

    @property
    def crate(self) -> str:
        parts = self.path.split(os.sep)
        return parts[1] if parts[0] == "crates" and len(parts) > 1 else parts[0]

    def text(self) -> str:
        with open(self.full, encoding="utf-8", errors="replace") as fh:
            return fh.read()

    def tokens(self) -> Iterator[Token]:
        return tokens(self.text(), self.lang)


class Corpus:
    """Every first-party source file of one tree, and what is known about it."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self.files: list[Source] = sorted(_collect(self.root), key=lambda s: s.path)
        self._by_path = {s.path: s for s in self.files}

    def of(self, *langs: str) -> list[Source]:
        return [s for s in self.files if s.lang in langs]

    def get(self, path: str) -> Source | None:
        return self._by_path.get(path)


def _collect(root: str) -> Iterator[Source]:
    for top, exts in ROOTS.items():
        base = os.path.join(root, top)
        if not os.path.isdir(base):
            continue
        for here, dirs, files in os.walk(base):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for name in sorted(files):
                ext = os.path.splitext(name)[1]
                if ext in exts:
                    full = os.path.join(here, name)
                    yield Source(os.path.relpath(full, root), LANG[ext], root)
