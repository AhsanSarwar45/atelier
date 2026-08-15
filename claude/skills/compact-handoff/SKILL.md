---
name: compact-handoff
description: Decide whether to compact, hand off to a fresh session, or just finish when a task has run long / over ~150-200K context / through many failed tries — and write the handoff brief if resetting. Use when a bugfix or feature is thrashing, the context feels bloated or noisy, or you're about to hit the window limit. Prevents both wasted re-discovery (resetting too eagerly) and context-rot (never resetting).
---

# compact-handoff

Long, noisy contexts make the model measurably worse ("context rot"), which
causes *more* failed tries — and the tries, not the token count, are the real
cost. The size number is not the trigger; **whether the context is helping or
hurting** is. This is a 3-way decision, not "reset yes/no".

## Decide

**Making real progress? → `/compact`, stay in the session.**
Compact distills the understanding (repro, buggy code, ruled-out hypotheses) and
drops raw file-dumps and error spew, resetting toward the ~21K floor *while
keeping the thread*. This is the default. Do NOT start a fresh session here — you
would pay to re-read every file and re-derive the repro, and risk repeating dead
ends.

**Thrashing — same failed approaches, context full of noise? → fresh session, but write the handoff below first.**
A degraded context won't recover; more turns make it worse. Reset, but never cold.

**One edit from done? → just finish it.** No ceremony.

## Handoff brief

⛔ **It goes on the card, never into a file.** `bd update <id> --append-notes="…"`
with the block below, then start the fresh session and claim that card — the notes
come with it. A handoff *document* is banned (`CLAUDE.md`): twelve of them once
stood over finished work.

Keep it ~200 tokens. This is worth more than 80K of raw failed-attempt transcript.

```
Task: <what we're fixing/building, in one line>
Repro: <exact car + skin + ext_config + camera + env + physical_lighting ON/OFF,
        or the exact command/scene config JSON>
Ruled out:
  - <approach A> — failed because <reason>
  - <approach B> — failed because <reason>
Current best lead: <the hypothesis or file:line to try next>
Relevant files: <path:line, path:line>
```

## Also consider (before resetting)
- **Delegate the next attempt to a subagent** — `scout` to relocate the code
  cleanly, this project's own verifier to test a fix, `researcher` to check the correct
  method. The subagent's file-reads and failed diffs die with it, so the main
  thread stays lean without a full reset.
- **New, unrelated task?** That's a different trigger — `/clear` (not compact),
  because the old task's context is pure dead weight on every future call.
