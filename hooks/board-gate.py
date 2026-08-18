#!/usr/bin/env python3
"""Stop hook — refuses to finish a turn while the board is behind the work, and
then while the work itself is unfinished.

Six refusals, in the order they matter: the board must be reachable at all; a
habit the manager pointed at this turn must have a card naming what produced it,
before anything he said gets answered; code changed in this turn must belong to a
card this session held when it changed it (`bc.unowned` — the held set at the
instant of stopping would make a job's clean finish look like work under no card
at all); anything the reply reports as found-but-not-fixed must already be
recorded, as a work item of this job or as a find of its own; a card this session
made must say how anyone would know it is done; and last, the job it is running
must be finished or waiting on somebody (`carry_on`, docs/board.md#4f-when-a-session-may-stop).

The first five buy a single retry each, given up the moment `stop_hook_active`
says one already fired: they catch a mistake in what was recorded, and a refusal
that should not have fired must cost one extra reply, never a wedged session. The
last one is the point of the gate rather than a guard against a slip, so it keeps
refusing to `PUSH_LIMIT`.
"""
import json
import os
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402

# Phrasing that reports a problem left standing — the fault named aloud and then
# put down. The rule it enforces is docs/board.md#two-ways: recorded one of two
# ways, never left in the session alone.
#
# Every phrase here has to be one an agent writes when it is deferring and not one
# it writes about the code. "deferred" and "later pass" are deliberately absent:
# this repository draws a deferred pass every frame.
DISCOVERY = re.compile(
    r"\b(out of scope|outside (the |its |this )?scope|unrelated (bug|issue|problem|defect)|"
    r"separate (issue|bug|ticket|card|change|fix)|pre-?existing (bug|issue|problem|defect)|"
    r"should be fixed separately|not (fixed|addressed|handled) (here|in this)|"
    r"worth a separate|another (bug|issue|problem)|"
    r"leav(e|es|ing) (it|this|that|them) (for now|for later|as[- ]is|alone)|"
    r"left (it |this |that |them )?as[- ]is|"
    r"(come|circle|get|go) back to (it|this|that|them)|"
    r"(fix|fixing|address|addressing|handle|handling|revisit|revisiting|deal with|"
    r"dealing with|look at|looking at|get to|getting to|do) (it|this|that|them) later|"
    r"not fixing (it|this|that|them)|"
    r"(a|another|its own) (later|future) (card|ticket|job|session|round|agent)|"
    r"follow[- ]?up (card|ticket|job)|"
    r"defer(s|red|ring)? (it|this|that|them)|"
    r"known issue|did ?n[o']?t fix|(wo|will|can) ?n[o']?t fix)",
    re.IGNORECASE,
)


QUIET_LIMIT = 4  # turns of code changes a held card may go without a word written to it

# Refusals to finish, in a row, before the unfinished-work gate lets the turn end
# anyway. One short of the harness's own cap (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP,
# default 8), so the session is never overruled with a warning the manager has to
# read. [SOURCED] docs/board.md#4f-when-a-session-may-stop
PUSH_LIMIT = 1

CARRY_ON = (
    "Work still open, nothing waiting on the manager: %s. Carry on, or ask "
    "him. docs/board.md#4f-when-a-session-may-stop"
)

# The link a report build prints, however the board screen was reachable.
LINK = re.compile(r"/api/reports/page|/reporting/pages/\S+\.html")
HANDOVER = (
    "You ticked off %s this turn, and this reply does not end on the link to its "
    "page. Finished work reaches the manager as a page: `report list` finds the one "
    "for this job, `report <slug>` prints its link, and the link goes LAST in the "
    "message — his standing instruction, so he does not scroll back up for the one "
    "thing he is meant to click."
)


# Seconds a reading still running is waited for. It is fired the moment his message
# arrives (hooks/habit-reading.py) and takes 5-8s, so a turn of any length
# has long since paid for it; this covers a turn that ended almost immediately.
HABIT_WAIT = 20
HABIT = (
    "He is pointing at how you work, not at one wrong answer: %(what)s.\n\n"
    "Answering the examples he named leaves whatever produced them running, and it "
    "produces them again next week. Before this reply ends, the CAUSE goes on the "
    "board — one card naming the thing that let this happen, not the instances:\n"
    '    %(pour)s find "<what is wrong>" "<where it is, how it shows>" '
    "--area <system> --kind bug\n"
    "`--area board` for the way work runs, `tooling`, `docs` or `tests` when the "
    "cause lives there. Then answer him: fix the examples too if you like, but say "
    "which card carries the cause."
)


def tally(name):
    """One row for the manager's count of what a refusal costs (board/cost.py).

    Counted after the refusal is already printed, and never at the cost of it: a
    full disk must not turn a gate into a gate that lets things through.
    """
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)),
                                        "..", "board"))
        import cost
        cost.record(name)
    except Exception:
        pass


def handed_over(message):
    """Whether the reply ends on the link, which is where the manager reads it."""
    lines = [l for l in (message or "").strip().splitlines() if l.strip()]
    return bool(lines) and bool(LINK.search(lines[-1]))


def rows(ids, root):
    """`bd show` as a list, empty when the board cannot answer."""
    if not ids:
        return []
    ok, out = bc.bd(["show"] + sorted(ids) + ["--json"], root)
    if not ok:
        return []
    try:
        got = json.loads(out or "[]")
    except Exception:
        return []
    return got if isinstance(got, list) else [got]


# A goal here is work this session is expected to carry on with. The rest are
# waiting on somebody who is not it: `in_review` on the board's own reader,
# `blocked` and `deferred` on another card or an outside date, `manager_review`
# on the manager's signature.
RUNNING = ("open", "in_progress")


def unfinished(state, mine, since, root):
    """This session's own work that is not done: the cards it still holds, and the
    goals it moved this turn that are still running.

    The second half is what a held set alone cannot see. Closing a step empties
    the held set for as long as it takes to claim the next one, and that gap is
    exactly where a session says what it has got to and waits.
    """
    left = set(mine or [])
    ticked = [c["id"] for c in state.get("closed") or [] if c.get("t", 0) > since]
    goals = {g[3:] for r in rows(ticked, root)
             for g in r.get("labels") or [] if g.startswith("of:")}
    left.update(r["id"] for r in rows(goals - left, root)
                if r.get("status") in RUNNING)
    return sorted(left)


def untagged(ids, root):
    """Cards missing either tag, each with the one it lacks."""
    ok, out = bc.bd(["show"] + ids + ["--json"], root)
    if not ok:
        return []
    try:
        rows = json.loads(out or "[]")
    except Exception:
        return []
    rows = rows if isinstance(rows, list) else [rows]
    bad = []
    for r in rows:
        labels = r.get("labels") or []
        for tag in ("area:", "kind:"):
            if not any(l.startswith(tag) and l != tag + "{{area}}" for l in labels):
                bad.append((r.get("id", "?"), tag.rstrip(":")))
    return bad


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))


def helper_busy(state, since):
    """Whether a helper this session sent off is still out.

    Counted by name, not by one mark: a session that sent three helpers off is
    still waiting when the first of them reports back, and a single mark cannot
    tell that from all three being home. Helpers that answer to a name are
    struck off as each returns (hooks/board-touch.py); one sent off with nothing
    to answer to holds only the turn it was sent in, because nothing will ever
    say it is home. What a helper closes while it is out is its own, not the
    waiting session's.
    """
    if state.get("helper_out"):
        return True
    return (state.get("helper") or 0) > since


def carry_on(sid, state, mine, since, root):
    """Send the session back to its own unfinished work, or close the turn.

    The last thing the gate does, so a turn is only ever sent back to work once
    everything it recorded is in order.
    """
    left = unfinished(state, mine, since, root)
    spent = state.get("pushes") or 0
    if left and (state.get("asked") or 0) <= since \
            and not helper_busy(state, since) and spent < PUSH_LIMIT:
        state["pushes"] = spent + 1
        bc.save(sid, state)
        block(CARRY_ON % ", ".join(left[:6]))
        tally("carry-on")
        return
    if left and spent >= PUSH_LIMIT:
        tally("carry-on-spent")
    state["pushes"] = 0
    state["last_stop"] = bc.now()
    bc.save(sid, state)


def main():
    data = json.load(sys.stdin)
    sid = data.get("session_id")
    state = bc.load(sid)
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not os.path.isdir(os.path.join(root, ".beads")) or bc.reviewing():
        return
    if bc.waived(sid):
        # A waived turn is finished, not skipped. A reviewer may be stood down
        # without a mark because it changes no file; a session working under his
        # waiver does change files, and leaving the turn's mark where it was
        # hands every one of them back as unclaimed work the moment the waiver
        # lifts. A waiver that bills you afterwards is not a waiver.
        state["pushes"] = 0
        state["last_stop"] = bc.now()
        bc.save(sid, state)
        return
    name = bc.actor(sid, data.get("cwd"))
    since = state.get("last_stop") or 0
    turn = [e for e in state.get("edits") or [] if e.get("t", 0) > since]
    edited = [e["p"] for e in turn]
    made = [c["id"] for c in state.get("created") or [] if c.get("t", 0) > since]
    mine = bc.held(name, root)
    # A turn the last refusal already sent back. Only the unfinished-work refusal
    # runs again: the five below catch a mistake, and a mistaken one must never
    # trap the session, so each still stands aside after saying its piece once.
    again = bool(data.get("stop_hook_active"))

    if mine is None:
        if again:
            return
        block(
            "The board did not answer, so no work state can be recorded. Bring it "
            "back before finishing: `bd ready` will say what is wrong (the Dolt "
            "server may be down). Do not carry on with the board unreachable."
        )
        return
    if again:
        carry_on(sid, state, mine, since, root)
        return

    # Read off the manager's own message, before this session wrote a word of its
    # defence. No answer, one still running past HABIT_WAIT, or the switch thrown
    # all read the same and let the turn end.
    if not bc.habit_off() and not made:
        habit = bc.habit_read(data.get("prompt_id"), HABIT_WAIT)
        # `is True` and not merely truthy: the reading writes a boolean, so anything
        # else in that slot is a file half-written or edited by hand, and a gate that
        # refuses on those refuses on damage rather than on an answer.
        if habit.get("habit") is True:
            block(HABIT % {"what": habit.get("what")
                                       or "a way of working he has named before",
                                       "pour": bc.tool(root, "job")})
            tally("habit-cause")
            return

    orphan = sorted({e["p"] for e in bc.unowned(state, turn, mine, since)})
    if orphan:
        loose = bc.held(bc.machine_name(root), root) or []
        block(
            "You changed %d file(s) this turn with no card claimed: %s\n\n"
            "The board owns work state. Claim the card this work belongs to "
            "(`bd update <id> --claim`), or pour the job first "
            "(`%s new --what … --evidence … --done … --area …`) "
            "and claim its first step. "
            "Your board name is %s — it is stamped on automatically, so run "
            "board commands on their own rather than chained after another tool.%s"
            % (len(orphan), ", ".join(orphan[:6]), bc.tool(root, "job"), name,
               ("\n\nThese are claimed under the shared machine name and own "
                "nothing: %s. Re-claim what is yours." % ", ".join(loose)) if loose else "")
        )
        return

    if mine and edited:
        if (state.get("last_write") or 0) > since:
            state["quiet_turns"] = 0
        else:
            state["quiet_turns"] = (state.get("quiet_turns") or 0) + 1
        if state["quiet_turns"] >= QUIET_LIMIT:
            state["quiet_turns"] = 0
            state["last_stop"] = bc.now()
            bc.save(sid, state)
            block(
                "You have held %s through %d turns of code changes without writing a "
                "word to it. Say where it stands before finishing: "
                "`bd update %s --append-notes=\"...\"`, or close it "
                "(`bd close %s --reason=\"...\"`) if it is done."
                % (", ".join(mine), QUIET_LIMIT, mine[0], mine[0])
            )
            return

    ticked = [c["id"] for c in state.get("closed") or [] if c.get("t", 0) > since]
    if ticked and not helper_busy(state, since) \
            and not handed_over(data.get("last_assistant_message")):
        block(HANDOVER % ", ".join(sorted(set(ticked))[:4]))
        return

    found = DISCOVERY.search(data.get("last_assistant_message") or "")
    if found and not made:
        block(
            'Your reply reports something left standing ("%s") and this turn '
            "recorded nothing. A fault never stays in the session's memory — it goes "
            "one of two ways before you finish, and there is no third:\n"
            "  RELATED — the same change would touch it, or it shares this job's "
            "cause. It is a work item on the current goal, and you fix it in this "
            "job rather than hand it on:\n"
            '    %s under <goal> --do "<what to do>|<how we know it is done>"\n'
            "  SEPARATE — another system or another cause, or it would swell this job "
            "past the done it was poured with. It is its own card:\n"
            '    %s find "<what is wrong>" "<where it is, how it shows>"'
            " --area <system> --kind <bug|feature|chore>\n"
            "If nothing was actually left standing, say so without the phrase."
            % (found.group(0), bc.tool(root, "job"), bc.tool(root, "job"))
        )
        return

    if made:
        ok, out = bc.bd(["lint", "--status", "all"] + made, root)
        if ok and "Missing:" in (out or ""):
            block(
                "A card you made this turn does not say how anyone would know it is "
                "done, so nobody can ever close it honestly:\n\n%s\n"
                "Fill it in — `bd update <id> --acceptance=\"<the command, and the "
                "number or image it must produce>\"`." % out.strip()[:1200]
            )
            return
        bare = untagged(made, root)
        if bare:
            block(
                "Every card carries two tags, and these do not: %s. One says which "
                "system it belongs to (`area:`), one says what kind of work it is "
                "(`kind:` — bug, feature or chore). Without both, the board cannot be "
                "read by system or by kind. `bd update <id> --add-label area:<system> "
                "--add-label kind:<bug|feature|chore>`, or pour the card again through "
                "`%s`, which requires both."
                % (", ".join("%s (%s)" % (c, w) for c, w in bare),
                   bc.tool(root, "job"))
            )
            return

    carry_on(sid, state, mine, since, root)


if __name__ == "__main__":
    main()
