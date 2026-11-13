---
name: tasks
description: Track work as Atelier tasks with the atelier task CLI, test-first.
---

# Tasks

The owner tracks work as tasks. A task belongs to the chat that holds it. Work
in the folder this chat was opened in; never create worktrees or branches for
a task.

Tasks are test-first. Every plan item carries the checks that prove it,
written before the work. The owner approves them with the plan, the server
locks them, runs them red at start, and ticks each item only when its checks
pass.

## When a task is needed

- Questions, explanations and a small edit to one file never need a task.
  Just answer or do it.
- Any other change to files needs a task: anything that edits two or more
  files, or one file in more than one place for different reasons. If the
  owner asks for such work and no task in this chat covers it, write only
  the check files, draft the task with its checks, run `atelier task
  propose` with it, and stop. Continue when the owner's choice arrives as a
  message: **Create task** (the task is made and its checks approved; start
  it), **Just do it** (do the work without a task) or **Cancel** (don't do
  it, and remove the check files you wrote).
- `@task TEXT` from the owner means: pick the type, draft the plan with its
  checks, and run `atelier task create`. Do not ask again. `create` is
  refused unless the owner's latest message has `@task`, or every cell it
  names is in an approved grid; otherwise propose.
- `@merge` from the owner comes with what git says about this folder and the
  steps to merge its branch into the base branch. Follow them exactly.
- Never create a task on your own to put work off. Suggest it as a follow-up
  on a result instead.

## Commands

Payloads are JSON on stdin. Run `atelier task types TYPE` for the type's
plan and result shape and its check recipe, and copy them.

```
atelier task list [--all]
atelier task show N
atelier task types [TYPE]
atelier task create            <<< '{"type":…,"title":…,"why":…,"plan":{…}}'
atelier task propose           <<< '{"type":…,"title":…,"why":…,"plan":{…}}'
atelier task start N
atelier task check N ITEM
atelier task block N --cause TEXT --needs TEXT
atelier task unblock N
atelier task amend N           <<< '{"plan":{…},"reason":…}'
atelier task done N            <<< '{"summary":…,"commits":[…],"followups":[…],"result":{…}}'
atelier task cancel N --reason TEXT
atelier task take N
```

Run each `atelier task` command as its own command and leave its output
alone. It prints the task card the owner sees in the chat. Never send it to
`/dev/null`, pipe it away, or bundle it into one command with the work.

Types: `bug`, `feature`, `ui_change`, `ui_feature`, `visual_bug`,
`render_change`, `render_feature`, `optimization`, `plan`, `investigation`,
`refactor`, `tests`, `review`, `qa`, `docs`, `chore`, `general`. Use
`general` only when no other type fits.

Anything you can see on screen or in a render takes a visual type:
`ui_feature` for new work you can see on screen, `render_feature` for new
work you can see in a 3D render (not `feature`), `ui_change` to change a
screen that is there, `render_change` to change what a scene renders, and
`visual_bug` for a bug you can see (not `bug`). Their checks test behaviour;
the owner judges the look at review from the `before`, `after` (and
`reference`) images the type's result asks for.

Safety net: `done` on a `feature` or `bug` is refused when its commits
change visual files (`.tsx`, `.jsx`, `.css`, `.scss`, `.html`, `.vue`,
`.svelte` and shaders by default, or the project's own list; tests do not
count), unless the result has `screens: [{name, before?, after}]`
screenshots. Pick the visual type up front instead.

## Writing checks

Each plan item gets `"checks": [ … ]`, one or more; all must pass for the
item to be met. A type without an item list puts them in the plan's own
`checks`.

```json
{"name": "repro", "kind": "test", "command": "cargo test -p app export_keeps_order",
 "given": "a project with 3 chats", "when": "it is exported", "then": "the chats keep their order",
 "red": "export_keeps_order.*FAILED", "files": ["server/tests/export.rs"], "timeout_s": 600}
```

`kind` is `test`, `structure` (a grep or file check), `benchmark` (with
`bench: {value, runs, warmup, budget}`) or `characterisation` (behaviour
that must stay the same, so it passes at start). `red` is a pattern the
failing output must match at start. `files` are the files the check relies
on; they are locked when the owner approves.

- One observable behaviour per check, and as many checks as the item needs.
- Assert outcomes: return values, DOM, files, HTTP responses, exit codes.
  Never assert that a mock was called. Mock only external boundaries.
- Each check fails for one stated reason, the one in `red`. Make the
  command print that reason.
- Keep each under about two minutes.
- Everything in a check's test folder is locked with it (helpers,
  fixtures, baselines), and a check that runs fewer tests than at start
  fails.
- Add `"mutants": true` to the plan for the deeper test at done: the server
  breaks the changed lines on purpose and reports how many breaks each
  item's checks catch; items that catch almost none are flagged
  `weak-checks`.
- Write the check files before you propose or create: their contents are
  what the owner approves and the server locks.

## Working a task

1. Propose (or create on `@task`) with every item's checks. `propose` and
   `create` refuse an item without one. The owner approves the plan and all
   its checks in one step.
2. `atelier task start N` runs every check on the starting commit. Each must
   fail with output matching its `red`; a characterisation check must pass.
   If start is refused, the check is wrong: fix it with `amend`.
3. Read the approved checks before writing code. They are the spec.
4. Make the smallest change that turns a check green, and implement the
   behaviour generally. Unit-level red-green inside an item is recommended,
   not required. Refactor in separate commits.
5. When an item's checks pass, run `atelier task check N ITEM`. The server
   runs them and ticks the item only if all pass ("2 of 3 checks pass"
   otherwise). Run it as each item turns green, not all at the end.
6. Finish with `atelier task done N`. Its result needs the summary, the
   commit SHAs for types that change code (they must exist) and the type's
   other fields; the items' results are the checks' runs. The server re-runs
   every check and the project's test command, refuses while any fails,
   reverts your non-check changes in a scratch checkout to confirm each
   check goes red again ("proves nothing" otherwise), and flags added skips
   and deleted tests to the owner.

## Never

- Never edit, delete, skip, rename or weaken an approved check file, the
  project's test harness config or a baseline. The server rejects the item
  ("approved check file changed").
- Never branch on test inputs, special-case the values a check uses,
  override equality or comparison, or add `exit` calls to tests.
- Never tick an item yourself or claim a check passed that you did not see
  pass.
- When a check is wrong or impossible to meet, run `atelier task amend N`
  with the corrected checks and a `reason` that says what you ran and what
  it printed. Wait for the owner; don't work around it. An amended check
  must go red again: filing the amend runs it against the starting code
  and refuses it if it doesn't. Don't touch its files until the owner
  answers, or the approval is refused and you must file again.

## Rules

1. Start a task before working on it. A chat holds one task in progress at a
   time.
2. Block only for a cause you cannot remove yourself, and say what is needed
   to resume.
3. To change the plan or its checks, run `amend`. The owner approves it.
   Never change scope silently.
4. `done` is refused while an item's checks fail. If an item cannot be met,
   amend it or block; don't finish around it.
5. Never leave a task in progress when the work stops. Finish, block or
   cancel it.
6. The checklist shows this chat's tasks. Do not keep a separate checklist.
7. A task whose plan has no checks (made before checks existed) keeps the
   old rules: `task check N ITEM` takes that item's result entry on stdin,
   in the shape `atelier task types TYPE` shows under `check`.

## The owner's answers

The owner's answers to a task arrive as messages:

- **Owner approved task #N.** The task is done. The message says where its
  commits stand. If they are not yet on the base branch, ask the owner
  whether to merge them. Never merge without the owner's yes. If merge
  state is unknown, check whether the commits are on the base branch before
  asking. If nothing is left to merge, there is nothing more to do.
- **Owner reopened task #N**, with a note: do what the note asks, then run
  `done` again. Start the task first if the message says so.
- **Owner approved the plan change**: continue with the new plan and its
  checks.
- **Owner rejected the plan change**: continue with the old plan, minding
  the owner's note if there is one.
- **The owner created task #N from a grid**: start it and work through its
  cells.

## Grids

A coverage grid lists an area's features (rows) against what each must do
(columns). Each cell is proved, a gap, or N/A, and a proof goes stale when
the covered code changes. `@matrix AREA` and `@audit SLUG` from the owner
come with their own steps; `@grid:…` comes with the cells it names. You may
draft a grid without `@matrix`; the owner approves or discards it.

Every column carries check templates when drafted (`"checks": [ … ]`, with
`{row}` replaced by the row id); a cell may add its own, or replace the
column's with `"override": true`. Approving the grid approves them. A cell
with no check shows "Needs a check" and cannot be claimed.

```
atelier grid list [--rows]
atelier grid show SLUG [ROW COL]
atelier grid next SLUG [--row ROW | --col COL]
atelier grid prove SLUG ROW COL  <<< '{"summary":…,"commits":[…]}'
atelier grid verify SLUG [ROW COL]
atelier grid na SLUG ROW COL --reason TEXT
atelier grid checks SLUG       <<< '{"columns":[{"id":…,"checks":[…]}]}'
```

A grid approved before checks shows every cell as "Needs a check". Add
column check templates with `atelier grid checks SLUG`; the owner approves
just those, and the grid's rows, cells and history stay. A check may list
extra paths in `watch`, so its cell's proof goes stale when they change.

To work through an approved grid: run `atelier grid next SLUG`, create the
task it prints (no `@task` needed), start it (each cell's checks must go
red), prove each cell, tick it with `atelier task check N ROW.COL`, finish
with `done`, and repeat until no gaps are left.

1. `grid prove` runs the cell's approved checks. Commit the covered code
   first.
2. To work on cells, list them as `cells` in the task's create or propose
   payload. A task with `cells` must end with proof, N/A or a reason for
   every cell (`done` takes `"cells":[{"grid","row","col","reason"}]`).
3. Leave cells another task claims alone.
4. Never pass or reopen cells outside an `@audit` request.
