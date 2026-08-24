#!/usr/bin/env python3
"""Which screens still paint their own controls instead of using the library's?

    one-library.py [path ...] [--list-rules] [--quiet]

The house rule is one component library: every button, picker, panel, backdrop
and card face on every screen comes from src/components/ui. The board grew up
somewhere else and paints most of its own, which is why it does not look like
the rest of the app.

Nothing about a hand-painted control fails a test — it renders, it clicks, it
just looks wrong beside everything else. So this reads the screens' own markup,
names every raw element carrying paint of its own, and exits non-zero, so it can
stand as a gate.

It reads markup, not intent: a raw <button> with no paint at all is left alone
(it is a click target, not a control), and everything under the library itself
is exempt because that is where the paint is supposed to live. Any other
exemption is named in EXEMPT below with its reason and printed in the summary,
so a skipped file is never a silent one.
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The library itself. Paint lives here by definition.
LIBRARY = "components/ui/"

# Files that stay hand-painted, each with the reason. Printed in the summary, so
# a skipped screen is never a silent one. Empty is the honest state: every screen
# outside the library is answerable to it.
EXEMPT = {}

# Classes that mean "this element paints itself" rather than "this element is
# positioned". Padding and flex are layout; a background is paint.
PAINT = re.compile(r"\b(bg-|border(\b|-)|rounded|shadow|ring-)")

SURFACE_TAGS = {"div", "section", "aside", "li", "header", "footer", "nav"}
PICKERS = {"select": "Select", "input": "Input", "textarea": "Textarea"}

# A JSX element opens with a lowercase name; an uppercase one is a component
# already, which is the thing we want.
TAG = re.compile(r"<([a-z][a-zA-Z0-9]*)[\s/>]")

QUOTED = re.compile(r"""(?:"([^"]*)"|'([^']*)'|`([^`]*)`)""", re.S)


def tag_span(text, start):
    """Where the opening tag beginning at `start` ends, minding quotes and braces."""
    depth = 0
    quote = None
    i = start
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote and text[i - 1] != "\\":
                quote = None
        elif ch in "\"'`":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == ">" and depth == 0:
            return i
        i += 1
    return len(text)


def class_names(attrs):
    """Every class string on the element, however it is spelled.

    className="..." and className={cn('...', flag && '...')} both end up as the
    set of words the browser would see, which is all a rule needs to judge.
    """
    at = attrs.find("className")
    if at < 0:
        return ""
    rest = attrs[at + len("className"):].lstrip()
    if not rest.startswith("="):
        return ""
    rest = rest[1:].lstrip()
    if rest[:1] in "\"'`":
        match = QUOTED.match(rest)
        return next(g for g in match.groups() if g is not None) if match else ""
    if rest[:1] != "{":
        return ""
    depth, i = 0, 0
    while i < len(rest):
        if rest[i] == "{":
            depth += 1
        elif rest[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return " ".join(
        next(g for g in m.groups() if g is not None)
        for m in QUOTED.finditer(rest[: i + 1])
    )


def offences_in(text):
    """Every hand-painted element in one file, as (line, rule, instead)."""
    found = []
    for match in TAG.finditer(text):
        tag = match.group(1)
        if tag in ("br", "hr", "img", "svg", "path", "circle", "rect", "line", "g"):
            continue
        end = tag_span(text, match.start())
        attrs = text[match.start() + 1 + len(tag): end]
        classes = class_names(attrs)
        line = text.count("\n", 0, match.start()) + 1
        painted = bool(PAINT.search(classes))

        if tag in PICKERS:
            found.append((line, f"a plain <{tag}>, which is the browser's own control",
                          f"<{PICKERS[tag]}> from the library"))
        elif tag == "button" and painted:
            found.append((line, "a <button> painted by hand",
                          "<Button> from the library"))
        elif "fixed inset-0" in classes and painted:
            found.append((line, "a dimmed backdrop painted by hand",
                          "the overlay <Dialog> or <Sheet> already draws"))
        elif tag in SURFACE_TAGS and "rounded" in classes and re.search(
                r"\bborder(\b|-)", classes):
            found.append((line, "a card or panel face painted by hand",
                          "<Card> or <Panel> from the library"))
    return found


def named(path):
    """A path the reader can click: relative to the repo when it is inside one."""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", default=["src"],
                        help="what to read; default is the whole of src")
    parser.add_argument("--quiet", action="store_true",
                        help="print the count only")
    args = parser.parse_args()

    files = []
    for given in args.paths or ["src"]:
        here = (ROOT / given) if not Path(given).is_absolute() else Path(given)
        files.extend(sorted(here.rglob("*.tsx")) if here.is_dir() else [here])

    skipped, total = [], 0
    for path in files:
        rel = named(path)
        if LIBRARY in rel:
            continue
        if rel in EXEMPT:
            skipped.append(rel)
            continue
        for line, rule, instead in offences_in(path.read_text()):
            total += 1
            if not args.quiet:
                print(f"{rel}:{line}: {rule} — use {instead}")

    for rel in skipped:
        print(f"skipped {rel}: {EXEMPT[rel]}")
    print(f"{total} hand-painted {'control' if total == 1 else 'controls'} "
          f"across {len(files)} screens")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
