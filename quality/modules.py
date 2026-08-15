"""What reaches what, read from the import lines rather than from anyone's memory.

An import line is the one place a dependency has to be written down, so a graph
built from those is the graph the compiler enforces. Nothing here is inferred: a
path that cannot be resolved to a module of this workspace is reported as
unresolved rather than guessed at, because a guessed edge is worse than a missing
one — it accuses code of a dependency it does not have.
"""
from __future__ import annotations

import os
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .corpus import Corpus, Source

# A `use` runs to its semicolon and may span lines; comments and attributes in the
# middle of one are dropped before it is read.
USE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(.+?);", re.M | re.S)
LINE_COMMENT = re.compile(r"//[^\n]*")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)

# Where a crate's own modules begin, and what the crate is called in an import.
ROOT_FILES = ("lib.rs", "main.rs")


def crate_name(path: str) -> str:
    """`crates/foo-core/src/…` -> `foo_core`, as an import spells it."""
    parts = path.split(os.sep)
    return parts[1].replace("-", "_") if len(parts) > 2 else ""


def module_of(src: Source) -> str | None:
    """The module path a file provides, or None if it is not part of a crate's source."""
    parts = src.path.split(os.sep)
    if len(parts) < 4 or parts[0] != "crates" or parts[2] != "src":
        return None
    inner = parts[3:]
    name = inner[-1]
    if name in ROOT_FILES:
        inner = inner[:-1]
    elif name == "mod.rs":
        inner = inner[:-1]
    else:
        inner = inner[:-1] + [name[:-3]]
    return "::".join([crate_name(src.path), *inner])


def _expand(path: str) -> list[str]:
    """`a::{b, c::{d, e}}` -> the paths it stands for."""
    path = path.strip()
    open_at = path.find("{")
    if open_at < 0:
        return [path]
    depth, close_at = 0, -1
    for i in range(open_at, len(path)):
        depth += (path[i] == "{") - (path[i] == "}")
        if depth == 0:
            close_at = i
            break
    if close_at < 0:
        return [path]
    head, tail = path[:open_at], path[close_at + 1:]
    out = []
    depth, piece = 0, ""
    for ch in path[open_at + 1:close_at] + ",":
        depth += (ch == "{") - (ch == "}")
        if ch == "," and depth == 0:
            if piece.strip():
                out += _expand(head + piece.strip() + tail)
            piece = ""
        else:
            piece += ch
    return out


def imports(text: str) -> list[list[str]]:
    """Every path a file imports, as segments, braces expanded and aliases dropped."""
    text = BLOCK_COMMENT.sub(" ", LINE_COMMENT.sub(" ", text))
    out = []
    for m in USE.finditer(text):
        for whole in _expand(m.group(1)):
            head = whole.split(" as ")[0].strip()
            segments = [s.strip() for s in head.split("::") if s.strip()]
            if segments:
                out.append(segments)
    return out


@dataclass
class Graph:
    """Modules of this workspace, and what each one reaches."""
    modules: set[str] = field(default_factory=set)
    inside: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    outside: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    unresolved: list[str] = field(default_factory=list)

    def crate(self, module: str) -> str:
        return module.split("::")[0]


def _longest_known(known: set[str], segments: list[str]) -> str | None:
    """The longest prefix of `segments` that names a module, `use` paths ending in
    an item rather than a module."""
    for cut in range(len(segments), 0, -1):
        candidate = "::".join(segments[:cut])
        if candidate in known:
            return candidate
    return None


def build(corpus: Corpus) -> Graph:
    graph = Graph()
    files = [(s, module_of(s)) for s in corpus.of("rust")]
    files = [(s, m) for s, m in files if m is not None]
    graph.modules = {m for _, m in files}
    crates = {m.split("::")[0] for m in graph.modules}

    for src, here in files:
        for segments in imports(src.text()):
            head = segments[0]
            if head == "crate":
                target = _longest_known(graph.modules, [graph.crate(here), *segments[1:]])
            elif head == "self":
                target = _longest_known(graph.modules, [*here.split("::"), *segments[1:]])
            elif head == "super":
                rest, up = segments[1:], 1
                while rest and rest[0] == "super":
                    rest, up = rest[1:], up + 1
                above = here.split("::")[:-up] or [graph.crate(here)]
                target = _longest_known(graph.modules, [*above, *rest])
            elif head in crates:
                target = _longest_known(graph.modules, segments)
            else:
                graph.outside[here].add(head)
                continue
            if target is None:
                # An unresolved path is almost always a re-export: the name lives
                # under a module this file never mentions.
                graph.unresolved.append(f"{src.path}: {'::'.join(segments)}")
                continue
            if target != here:
                graph.inside[here].add(target)
    return graph
