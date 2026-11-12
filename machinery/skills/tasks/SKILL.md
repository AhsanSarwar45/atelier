---
name: tasks
description: Track work as Atelier tasks with the atelier task CLI.
---

# Tasks

The owner tracks work as tasks. A task belongs to the chat that holds it. Work
in the folder this chat was opened in; never create worktrees or branches for
a task.

## When a task is needed

- Questions, explanations and a small edit to one file never need a task.
  Just answer or do it.
- Any other change to files needs a task: anything that edits two or more
  files, or one file in more than one place for different reasons. If the
  owner asks for such work and no task in this chat covers it, stop before
  editing anything: draft the task, run `atelier task propose` with it, and
  stop. Continue when the owner's choice arrives as a message: **Create
  task** (the task is made for you; start it), **Just do it** (do the work
  without a task) or **Cancel** (don't do it).
- `@task TEXT` from the owner means: pick the type, draft the plan, and run
  `atelier task create`. Do not ask again. `create` is refused unless the
  owner's latest message has `@task`; otherwise propose.
- `@merge` from the owner comes with what git says about this folder and the
  steps to merge its branch into the base branch. Follow them exactly.
- Never create a task on your own to put work off. Suggest it as a follow-up
  on a result instead.

## Commands

Payloads are JSON on stdin. Run `atelier task types TYPE` for the exact plan
and result shape of a type, and copy it.

```
atelier task list [--all]
atelier task show N
atelier task create            <<< '{"type":…,"title":…,"why":…,"plan":{…}}'
atelier task propose           <<< '{"type":…,"title":…,"why":…,"plan":{…}}'
atelier task start N
atelier task check N ITEM      <<< '{…one plan item's result entry…}'
atelier task block N --cause TEXT --needs TEXT
atelier task unblock N
atelier task amend N           <<< '{"plan":{…}}'
atelier task done N            <<< '{"summary":…,"commits":[…],"followups":[…],"result":{…}}'
atelier task cancel N --reason TEXT
atelier task take N
```

Run each `atelier task` command as its own command and leave its output
alone. It prints the task card the owner sees in the chat. Never send it to
`/dev/null`, pipe it away, or bundle it into one command with the work.

Types: `bug`, `feature`, `ui_change`, `optimization`, `plan`,
`investigation`, `refactor`, `tests`, `review`, `qa`, `docs`, `chore`,
`general`. Use `general` only when no other type fits.

## Rules

1. Start a task before working on it. A chat holds one task in progress at a
   time.
2. As soon as a plan item is met or missed, run `atelier task check N ITEM`
   with that item's result entry (the shape `atelier task types TYPE` shows
   under `check`), not all at the end. Running it again replaces the entry.
3. Block only for a cause you cannot remove yourself, and say what is needed
   to resume.
4. To change the plan, run `amend`. The owner approves it. Never change scope
   silently.
5. Finish with `done`: its result only needs the items you have not checked
   (an entry given there wins), so every plan item ends with an entry. If an
   item was not met, say why in that entry. Types that change code need
   the commit SHAs, and the commits must exist.
6. Never leave a task in progress when the work stops. Finish, block or
   cancel it.
7. The checklist shows this chat's tasks. Do not keep a separate checklist.

## Grids

A coverage grid lists an area's features (rows) against what each must do
(columns). Each cell is proved, a gap, or N/A, and a proof goes stale when
the covered code changes. `@matrix AREA` and `@audit SLUG` from the owner
come with their own steps; `@grid:…` comes with the cells it names.

```
atelier grid list [--rows]
atelier grid show SLUG [ROW COL]
atelier grid prove SLUG ROW COL  <<< '{"summary":…,"checks":[{"name":…,"command":…}],"commits":[…]}'
atelier grid verify SLUG [ROW COL]
atelier grid na SLUG ROW COL --reason TEXT
```

1. Prove only with checks that pass, and commit the covered code first.
2. To work on cells, list them as `cells` in the task's create or propose
   payload. A task with `cells` must end with proof, N/A or a reason for
   every cell (`done` takes `"cells":[{"grid","row","col","reason"}]`).
3. Never pass or reopen cells outside an `@audit` request.
