#!/usr/bin/env python3
"""Count the three habits the manager named, in replies a style produced.

An aside tucked in after a dash, a list opened with a colon, and the "X, not Y"
flourish. Counted rather than argued about: on the shape count alone the file
that read worst once scored best, so the number settles nothing on its own, but
it does settle whether a rewrite moved the habits at all.

    style-count.py <replies-dir> <style> [<style> ...]
"""
import re
import sys

FENCE = re.compile(r"```.*?```", re.S)
COLOUR = re.compile(r"\x1b\[[0-9;]*m")
DASH = re.compile(r"\s[\u2014\u2013-]\s")
COLON = re.compile(r"\w:\s+\w")
NOTY = re.compile(r",\s*(?:not|rather than|instead of)\s")


def counted(text):
    """The three habits and the word count, with code blocks left out of both."""
    prose = COLOUR.sub("", FENCE.sub("", text))
    hits = (len(DASH.findall(prose)), len(COLON.findall(prose)), len(NOTY.findall(prose)))
    return hits, max(len(prose.split()), 1)


def main():
    where, styles = sys.argv[1], sys.argv[2:]
    print("%-16s %6s %6s %6s %6s %9s"
          % ("style", "words", "dash", "colon", "notY", "per 100w"))
    for style in styles:
        with open("%s/all.%s" % (where, style)) as fh:
            (dash, colon, noty), words = counted(fh.read())
        print("%-16s %6d %6d %6d %6d %9.1f"
              % (style, words, dash, colon, noty, (dash + colon + noty) * 100 / words))


if __name__ == "__main__":
    main()
