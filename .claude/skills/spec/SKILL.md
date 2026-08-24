---
name: spec
description: Interview the manager into a complete spec for a big feature, write it as a committed handoff, and hand implementation to a fresh session with clean context. Use before any large or multi-session feature.
---

# Spec interview, then a fresh implementation session

Big tasks drift while they run, and no known fix exists. The countermeasure is
structural: pin the spec in THIS session, implement in a FRESH one whose
whole context is the spec.

## Steps

1. **Interview** with AskUserQuestion, batches of 2–4 sharp questions, until
   pinned: the goal (one sentence), acceptance checks, visual/behavioral
   references, non-goals, constraints. Ask only about manager-level calls: the
   result, the quality bar, the priorities. Anything an engineer can decide, decide yourself
   and state it in the spec instead of asking.
2. **Open the job on the board**, never as a document.
   Run `job new --what … --evidence … --done … --area …`, through whatever path this
   project keeps the pour tool at. The goal sentence is `--what`, and `--done` is
   the acceptance check, which must be mechanical: the run this project proves a
   change with, a bench delta, a red-then-green repro. Never "looks good".
   References, non-goals and constraints go on the goal card
   with `bd update <id> --append-notes`. Leave zero open questions. Resolve them
   in the interview or decide them yourself.
3. **Hand off**: tell the manager the card id, and suggest a fresh session
   claim it (`bd update <id> --claim`) and arm the acceptance check as a
   standing condition (`/goal <check>`). This session goes no further on the
   feature.
