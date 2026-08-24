#!/usr/bin/env python3
"""SessionStart — hands the session its board identity, the loop it must run,
and the work that is ready.

It also runs the reaper first, so cards abandoned by a session that died are
back on the ready list before this one picks work.
"""
import json
import os
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "board"))
import board_common as bc  # noqa: E402
import sections  # noqa: E402
import spine  # noqa: E402

RULES = """# Board — the only place work state lives

Your board name: {name} (stamped onto your board commands for you).

Every time: `bd ready` -> `bd update <id> --claim` -> work -> `bd close <id> --reason="..."`.
One claim covers the whole job, so closing a piece gives you whatever opens after
it, either the next step or the next work item nobody is holding. Nothing after the
first card is claimed by hand.

- Changing code requires a claimed card. The stop gate refuses to finish a turn without one.
- A fault you find goes one of two ways before the turn ends, never into your head alone.
  A related fault is one the same change would touch, or one that shares this job's
  cause. It becomes a work item on the current goal and is fixed here and now:
  `{pour} under <goal> --do "<what to do>|<how we know it is done>"`.
  A separate fault belongs to another system or another cause, or it would swell the
  job past its `--done`. It gets its own card:
  `{pour} find "<what is wrong>" "<where it is, how it shows>"
  --area <system> --kind <bug|feature|chore>`.
  Those are the only two routes, and the stop gate enforces it.
- Every card needs both tags. `area:` names the system ({areas}). `kind:` is
  bug, feature or chore.
  The pour tool requires them and the stop gate refuses a turn that made a card without them.
- Cards are never written by hand. `bd create` is refused. A job opens with
  `{pour} new --what … --evidence … --done … --area … --kind …
  --steps <the optional ones it runs>`, which creates the goal and its first step.
  Closing a step opens the next one and gives it to you, so a job never shows a step
  nobody has thought about yet. A goal is not claimable, so claim its step. Promote a
  find with `job new --source <id> …`.
- The playbook IS the run of steps: {steps}. The bracketed ones
  run only when `--steps` names them. You do not need the ones it does not name.
  The rest are mandatory. A speed claim in `--done` selects benchmark by itself and
  cannot be dropped. A document named in `--done` or in `--record` selects record.
- Every step is proved by one of three things, and the close gate knows which.
  A commit naming THAT step on main. A note with its own evidence: a run with its
  number, the exact command the checks step ran and the count it came back with, a
  source, the manager's words, the review's points. Or an outside fact: you are
  standing in the worktree, the tree and branch are gone, the slot is free.
  A step that declared it makes no code cannot close if this session edited the project
  while holding it.
- The work items are the job's own children, not a card called Build:
  `{pour} under <goal> --do "<what to do>|<how we know it is done>" --do …`.
  The run waits there for the last item to close. A card with open children is a
  container and cannot be claimed.
- The checks step is the project's own checks command, run once over everything the
  job built and in front of the reader. Not per edit, and not from the commit hook,
  which no longer runs it. Its note gives the exact command and the count it came
  back with. A project that declares none says on the card what it ran instead.
- The board keeps the order of the work and the notes
  (`bd update <id> --append-notes="..."`). Docs and comments may name a card and
  nothing else: no TODO lines, no handoff files, no plan-in-a-doc.
- Your history compacts itself at 200k tokens. Let it take the old transcript when a
  step lands. The board and the tree keep the work state, and these rules arrive
  again after.
- Merging is how a code step closes, once per step rather than once per job. One
  command from your own tree does all of it, `{land} <card>`, and it
  gives the slot back even when the merge fails. By hand it is four commands:
  `git rebase main`, `bd merge-slot acquire`, `git merge --ff-only <branch>`,
  `bd merge-slot release`. A merge that is not a fast-forward is refused whoever
  holds the slot.
- Every commit names its card, and a card closes only once a commit naming it is on
  main. A commit does not move anything on the board. A job reaches the agents'
  review column when its last piece has closed and nobody is building it. That is
  what the column means, and the run puts it there itself.
- You stop for one of three reasons and no others: your own work is finished,
  you have put a question to the manager, or a helper you sent off is still running.
  Reporting where you have got to and waiting is not one of them. The manager owns the
  result, not the running of the job. The stop gate sends you back to work otherwise.
- A claim holds for five minutes and your own activity refreshes it. A session that
  dies has its cards handed back automatically.
- Run board commands on their own line, not chained behind another tool. That is
  what keeps your name on them.
"""


def cards(args, root):
    ok, out = bc.bd(args, root)
    try:
        rows = json.loads(out or "[]") if ok else []
    except Exception:
        return []
    return ["  %s P%s %s%s" % (r["id"], r.get("priority", "?"), r.get("title", ""),
                               "  [%s]" % r["assignee"] if r.get("assignee") else "")
            for r in rows]


def main():
    data = json.load(sys.stdin)
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not os.path.isdir(os.path.join(root, ".beads")) or bc.reviewing():
        return
    name = bc.actor(data.get("session_id"), data.get("cwd"))
    bc.bd(["reclaim", "--older-than", "10m", "--actor", name], root)

    # A session opens a turn, so the gates that ask what happened "this turn" have
    # a moment to measure from rather than the beginning of time. Only when there
    # is none: this also runs on a compact, mid-turn, and moving the clock there
    # would forgive every refusal the turn had already earned.
    sid = data.get("session_id")
    state = bc.load(sid)
    if not state.get("last_stop"):
        state["last_stop"] = bc.now()
        bc.save(sid, state)

    sections.use(root)
    out = [RULES.format(
        name=name, pour=bc.tool(root, "job"), land=bc.tool(root, "land"),
        areas=", ".join(sections.AREAS) or "none declared yet",
        steps=", ".join(("[%s]" % s) if spine.tier(s) != spine.MUST else s
                        for s in spine.ORDER))]
    for heading, args in (
        ("Ready now", ["ready", "--limit", "8"]),
        ("Held by someone right now", ["list", "--status", "in_progress"]),
        ("A month without movement — offer these to the manager to bin",
         ["stale", "--days", "30", "--limit", "5"]),
    ):
        rows = cards(args + ["--brief", "--json", "--actor", name], root)
        if rows:
            out.append(heading + ":\n" + "\n".join(rows))

    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n\n".join(out),
    }}))


if __name__ == "__main__":
    main()
