---
name: compact-handoff
description: Decide whether to compact, hand off to a fresh session, or just finish when a task has run long / over ~150-200K context / through many failed tries — and write the handoff brief if resetting. Use when a task is thrashing, the context feels bloated or noisy, or you're about to hit the window limit. Prevents both wasted re-discovery (resetting too eagerly) and context-rot (never resetting).
---

# compact-handoff

Long, noisy contexts make the model measurably worse ("context rot"), which
causes *more* failed tries. The tries, not the token count, are what it
costs. The size number is not the trigger. **Whether the context is helping or
hurting** is. This is a 3-way decision, not "reset yes/no".

## Decide

**Getting somewhere? → `/compact`, stay in the session.**
Compact distills the understanding (the goal, the relevant code, what's been ruled
out) and drops raw file-dumps and error spew, *while keeping the thread*. This is
the default. Do NOT start a fresh session here, because you would pay to re-discover
everything and risk repeating dead ends.

**Thrashing.** Same failed approaches, context full of noise? Start a fresh session, but write the handoff below first.
A degraded context won't recover, and more turns make it worse. Reset, but never cold.

**One step from done? → just finish it.** No ceremony.

## Handoff brief (paste into the fresh session)

Keep it ~200 tokens. Worth more than tens of thousands of tokens of raw
failed-attempt transcript.

```
Task: <what we're doing, one line>
Repro / how to run: <exact command or steps to reproduce the state>
Ruled out:
  - <approach A> — failed because <reason>
  - <approach B> — failed because <reason>
Current best lead: <the hypothesis or file:line to try next>
Relevant files: <path:line, path:line>
```

## Also consider (before resetting)
- **Delegate the next attempt to a subagent** (a `scout` to relocate cleanly, a
  verify-style agent to test a fix, a `researcher` to check the correct method).
  Its reads and failed diffs die with it, so the main thread stays lean without a
  full reset.
- **New, unrelated task?** That's a different trigger: `/clear` (not compact),
  because the old task's context is pure dead weight on every future call.
