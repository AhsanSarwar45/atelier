#!/usr/bin/env python3
"""The words a card may reach the manager in.

His screen draws a card's title and the report builder pulls it onto a page
unedited, so a title is manager-facing prose and answers to the same list every
report answers to. That list is not copied here: two copies drift, and then the
board and the page disagree about the same word.

⛔ Only the manager-facing line is checked — a card's title. The evidence and
the success criteria are required to name files, commands and numbers, which is
exactly what the list bans; holding those to it would set the two rules against
each other. See docs/board.md#4d-the-words-a-card-is-written-in.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "hooks"))
import board_common as bc  # noqa: E402


class Unreadable(Exception):
    """The word list could not be read, so nothing here has been checked."""


def _jargon():
    """The report builder's own check, from wherever the shared tools live."""
    tools = os.path.join(bc.reports_dir(), "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    try:
        from jargon import jargon
    except Exception as exc:
        raise Unreadable(exc)
    return jargon


def problems(text):
    """Every term in `text` the manager would have to decode, each with its fix."""
    return _jargon()(text or "", set())


def words():
    """The list itself: what to say instead of each term, and the shapes that are
    not words at all.

    Handed out so a writer can compose through the list rather than be judged by
    it afterwards — the outside reader does exactly that (`board/review`). Loaded
    the same way `problems` loads it, so the check and the repair can never come
    apart into two lists.
    """
    _jargon()
    from jargon import BANNED, SHAPES, SHAPE_EXEMPT
    return BANNED, SHAPES, SHAPE_EXEMPT


# A card carries its own id in a note often enough, and an id is not a word.
def refusal(text, what):
    """The rewrite this line earns, or "" if the manager can read it.

    Handed back rather than exited on, so a caller collecting everything wrong
    with one command can put this beside the rest of it. `refuse` below is the
    same answer with the exit still attached.

    A list that cannot be read refuses rather than waves through: a check that
    could not run is not a check that passed — the same rule the close gate
    already applies to a board it cannot query.
    """
    try:
        found = problems(text)
    except Unreadable as exc:
        return (
            "%s cannot be checked for the words the manager reads: the shared word "
            "list would not load (%s). A check that could not run is not a check "
            "that passed — fix the list, or say why it is gone, before pouring."
            % (what, exc)
        )
    if not found:
        return ""
    return (
        "%s is written in the words of whoever built the thing, and the manager has "
        "to be able to read it — his screen draws this line and every report page "
        "quotes it unedited. Rewrite it saying what the thing DOES:\n  %s"
        % (what, "\n  ".join(found))
    )


def refuse(text, what):
    """Exit with the rewrite to make, or return having found nothing."""
    said = refusal(text, what)
    if said:
        sys.exit(said)
