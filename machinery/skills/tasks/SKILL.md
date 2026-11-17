---
name: tasks
description: Track work as Atelier tasks with the atelier task CLI, test-first.
---

# Tasks

The owner tracks work as tasks, test-first: every plan item carries the
checks that prove it, written before the work. A task belongs to the chat
that holds it. Work in this chat's folder; never create worktrees or
branches for a task.

## When a task is needed

- Questions, explanations and a small edit to one file need no task. Any
  other file change does: two or more files, or one file in several places
  for different reasons. If no task in this chat covers it, write only the
  check files, run `atelier task propose`, and stop. The owner answers
  **Create task** (start it), **Just do it** (work without a task),
  **Cancel** (remove the check files) or **Request changes** with a note
  (revise and propose again). A new proposal replaces a waiting one.
- `@task TEXT`: pick the type, draft the plan with checks and run `atelier
  task create` without asking. `create` is refused unless the owner's latest
  message has `@task` or every cell it names is in an approved grid.
- `@merge` comes with git's state and the merge steps; follow them exactly.
- Never create a task to put work off; suggest it as a follow-up instead.

## Commands

Payloads are JSON on stdin; copy their shape from `atelier task types TYPE`.

```
atelier task list [--all]
atelier task show N
atelier task types [TYPE]
atelier task create|propose    <<< '{"type":…,"title":…,"why":…,"decisions":{…},"plan":{…}}'
atelier task start N
atelier task check N ITEM
atelier task block N --cause TEXT --needs TEXT
atelier task unblock N
atelier task amend N           <<< '{"plan":{…},"reason":…}'
atelier task done N            <<< '{"summary":…,"commits":[…],"followups":[…],"result":{…}}'
atelier task cancel N --reason TEXT
atelier task take N
atelier task note N --text TEXT
```

- Run each `atelier task` command on its own and leave its output alone: it
  prints the card the owner sees. Never pipe it away or bundle it with work.
- `atelier task note N --text TEXT` leaves a note on any task for whoever
  works on it. `task show` prints the notes; read them first.

## Types

`bug`, `feature`, `ui_change`, `ui_feature`, `ui_bug`, `render_change`,
`render_feature`, `render_bug`, `optimization`, `plan`, `investigation`,
`refactor`, `tests`, `review`, `qa`, `docs`, `chore`, `general`, plus any
the install or project adds. `atelier task types` lists those on for this
project. Use `general` only when nothing else fits.

- **Decisions**: `create` and `propose` give one line per type that is on,
  `{"bug": "…", "feature": "…", …}`: why the chosen type fits and why each
  other does not. A missing or blank line is refused.
- **Default items** every task of a type must do: answer each in
  `plan.requirements` with its id, text and `checks`, or `declined` with a
  one-line reason: `"requirements": [{"id": "phone", "text": "…", "checks":
  [ … ]}]`. `create` is refused while one is missing. A task keeps the
  items it was created with.
- **Visual work** takes a visual type: `ui_feature`, `ui_change`, `ui_bug`
  (broken layout, cut-off text, a dead control) on screen, `render_feature`,
  `render_change`, `render_bug` (wrong lighting, flicker, aliasing, missing
  geometry) in a 3D render; `bug` and `feature` have nothing to see. Checks
  test behaviour; the owner judges the look from the result's `before`,
  `after` (and `reference`) images. `done` on a `feature` or `bug` whose
  commits change visual files (`.tsx`, `.jsx`, `.css`, `.scss`, `.html`,
  `.vue`, `.svelte`, shaders or the project's list) needs
  `screens: [{name, before?, after}]`.
- **Skills**: a type may name `"skills"` to read first; `create` and
  `start` name them.
- **Changing types**: only with the CLI below (`--scope install|project`,
  default project); the owner can undo every change. Add a type or item only
  when the owner asks or the project keeps repeating the same work. A new
  type is planned like `general`; built-in types change only their items.

```
atelier task types create       <<< '{"name":…,"description":…,"code":true,"review":false,"items":[{"id":…,"text":…,"checks":[…]}],"skills":[…]}'
atelier task types edit TYPE    <<< '{"items":[…]}'   (or '{"skills":["ui-copy"]}')
atelier task types disable TYPE [--item ID]
atelier task types enable TYPE [--item ID]
atelier task types undo
```

## Writing checks

Each plan item gets `"checks": [ … ]`; all must pass for it to be met, and
`propose` and `create` refuse an item without one. A type without items puts
them in the plan's own `checks`.

```json
{"name": "repro", "kind": "test", "command": "cargo test -p app export_keeps_order",
 "given": "a project with 3 chats", "when": "it is exported", "then": "the chats keep their order",
 "red": "export_keeps_order.*FAILED", "files": ["server/tests/export.rs"], "timeout_s": 600}
```

`kind` is `test`, `structure` (a grep or file check), `benchmark` (with
`bench: {value, runs, warmup, budget}`) or `characterisation` (behaviour
that must not change; passes at start). `red` is what the failing output
matches at start. `files` are what the check relies on, recorded at
approval.

- One observable behaviour per check, as many as the item needs.
- Assert outcomes (return values, DOM, files, HTTP responses, exit codes),
  never that a mock was called. Mock only external boundaries.
- Each check fails for the one reason in `red`, which its command prints,
  and runs in under about two minutes.
- Write the check files before you propose or create; the owner approves
  their contents.
- Nothing is locked: checks run on the files as they are. You may update
  tests your change makes out of date; `task check` and `done` then warn
  you to make sure no check was weakened. A check running fewer tests than
  at start fails.

## Working a task

1. `atelier task start N` before any work; a chat has one task in progress.
   Start runs every check on the starting commit: each must fail matching
   its `red`, a characterisation check must pass. If start is refused, fix
   the check with `amend`.
2. The approved checks are the spec; read them before writing code.
3. Make the smallest general change that turns a check green (unit-level
   red-green is optional). Refactor in separate commits.
4. As each item's checks pass, `atelier task check N ITEM` runs them and
   ticks the item only if all pass.
5. `atelier task done N` takes the summary, existing commit SHAs for types
   that change code, and the type's other fields (items' results are the
   checks' runs). It re-runs every check and the project's test command,
   refuses while any fails, and shows the owner added skips and deleted
   tests.

- Change the plan or checks only with `amend`, its `reason` saying what you
  ran and what it printed; never change scope silently. It applies at once;
  the owner can undo it. If the reply says it may weaken what the owner
  approved, make sure it doesn't, or amend it back.
- Block only for a cause you cannot remove, saying what resumes it. When
  work stops, finish, block or cancel the task.
- The chat's checklist shows its tasks; keep no other.
- A task made before checks existed: `task check N ITEM` takes the item's
  result on stdin, shaped as `atelier task types TYPE` shows under `check`.

## Never

- Weaken, delete, skip or rename an approved check, the test harness config
  or a baseline to get green. A check file edited for another reason (a
  Rust test shares its file with the code) must still test the real
  behaviour.
- Branch on test inputs, special-case a check's values, override equality
  or comparison, or add `exit` calls to tests.
- Tick an item yourself, or claim a check passed you did not see pass.
- Finish around an unmeetable item: amend it or block.

## The owner's answers

- **Owner approved task #N**: it is finished. Leave its commits and branch;
  merging is the owner's call, with `@merge`.
- **Owner reopened task #N** with a note: do it, then `done` again
  (starting the task first if the message says so).
- **Owner undid the plan change**: continue with the earlier plan.
- **The owner created task #N from a grid**: start it and work its cells.

## Grids

A coverage grid lists an area's features (rows) against what each must do
(columns). A cell is proved, a gap or N/A; a proof goes stale when its
covered code changes. `@matrix AREA` and `@audit SLUG` come with their own
steps, `@grid:…` with the cells it names. You may draft a grid without
`@matrix`; the owner approves it.

```
atelier grid list|show SLUG [ROW COL]
atelier grid next SLUG [--row ROW | --col COL] [--batch N]
atelier grid order SLUG        <<< '{"rows":[{"id":…,"after":[…],"reason":…}],"columns":[…],"cells":[{"row":…,"col":…,"after":[["ROW","COL"]],"reason":…}]}'
atelier grid cases SLUG ROW COL  <<< '{"cases":[{"id":…,"given":…,"when":…,"then":…,"command":…,"covers":"r1g1"}],"dismiss":{"GAP":"reason"}}'
atelier grid review SLUG ROW COL
atelier grid prove SLUG ROW COL  <<< '{"summary":…,"commits":[…]}'
atelier grid verify|na|reopen SLUG ROW COL [--reason TEXT]
atelier grid note SLUG [--row ROW] [--col COL] --text TEXT
atelier grid checks SLUG       <<< '{"columns":[{"id":…,"checks":[…]}]}'
```

**Checks.** A column's check templates apply to every row; `{row}` is
their only placeholder. Row-specific scenarios belong in the cell's cases.
A cell may add checks or replace them with `"override": true`; `watch`
paths also make a proof stale.
A cell without checks shows "Needs a check"; add column templates with
`atelier grid checks SLUG`. Every check prints exactly one line
`CASE <grid>/<row>/<col>/<case> PASS|FAIL <measured> <limit>` (`-` when
none); wrap a command in `atelier case ID -- COMMAND`. Zero or several
lines, or another id, make the run invalid; `red` must contain the case id.

**Order.** A grid has no default order. Before anything else, write it
with `atelier grid order`: every row and column, in working order, each
with a reason; `after` names only earlier entries. Until then cells show
"Needs order".

**Cases.** Then give each cell its cases (one scenario each) with
`atelier grid cases`, then run `atelier grid review`: a fresh agent lists
missing scenarios as gaps. Answer each with a case (`covers`) or a
dismissal with a reason, and review again until no gaps (3 rounds, then the
owner decides). The owner approves a whole row's cases. Until then its cells
show "Needs cases" and cannot be claimed. Editing cases restarts review.

**Steps.** order → cases → reviewed → approved → red → work → proved (or N/A).
`grid show SLUG ROW COL` prints `Step: STEP. Next: COMMAND`; every reply
names them, and anything out of order is refused.

**The loop.** `atelier grid next SLUG` (first ready cell; `--batch N`
only for cheap cells) → create the
task it prints (no `@task`) → start it → commit → `grid prove` (runs the
approved checks) → `atelier task check N ROW.COL` → `done` → repeat.

- A task with `cells` ends with proof, N/A or a reason for each (`done`
  takes `"cells":[{"grid","row","col","reason"}]`). Leave others' cells alone.
- Pass cells only in an `@audit` request; reopen a cell that no longer
  meets its requirement with `atelier grid reopen`; new column checks
  reopen that column's proved cells.
- Leave notes with `atelier grid note`; read those `grid next` prints.
