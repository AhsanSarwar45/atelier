# Tasks

A task is a piece of work owned by the app, tied to the chat session that
holds it, with a type that decides what the agent must promise when it creates
the task and what it must prove when it finishes.

## Principles

- The app owns tasks. There is no separate board to keep in sync, no hooks
  that police it, and no landing step. The only way to change a task is the
  `atelier task` CLI (agents) or the Tasks screen (the owner).
- Agents work in the worktree the owner opened the session in. They never
  create worktrees or branches for a task.
- Agents never create a task on their own initiative. The owner asks with
  `@task`, or the agent proposes one (`atelier task propose`) and the owner
  answers **Create task**. The server enforces this: an agent's `create` is
  refused unless the session's latest owner message has a bare `@task`.
- Each type has a plan (given at create) and a result (given at done). The
  server rejects a result that does not cover the plan.
- Tasks are test-first. Every plan item carries one or more checks, written
  before the work and approved by the owner with the plan in one step. The
  server records the files they rely on, requires them to fail at start and
  pass at done, and ticks items itself. Agents cannot tick an item by
  saying so (see Checks).
- "Done" means the result is accepted, and for code-changing types that the
  named commits exist in the session's repository. Merging is separate: the
  card shows whether the commits reached the base branch, and the owner asks
  for a merge with `@merge` (see Merging).

## Data

Stored in `workbench.db`.

`task`

| column | type | notes |
|---|---|---|
| `project_id` | text | with `number`, the key |
| `number` | integer | per project, from 1; shown as `#12` |
| `type` | text | one of the types below |
| `title` | text | ≤ 120 chars |
| `why` | text | one line, ≤ 300 chars |
| `status` | text | `todo`, `in_progress`, `blocked`, `review`, `done`, `cancelled` |
| `session_id` | text, null | the session that holds it; null = unassigned |
| `created_by` | text, null | session that created it |
| `plan` | json | the type's plan |
| `result` | json, null | the type's result plus shared done fields, flat: `{summary, commits, followups, ...result}` |
| `shortfalls` | integer | 1 when done but some plan item was not met |
| `blocked` | json, null | `{cause, needed_to_resume}` |
| `cancel_reason` | text, null | |
| `pending_amend` | json, null | unused: plan changes once waited for the owner here |
| `checks` | json, null | plan items checked while in progress: `{<result list>: [entry, …]}` in plan order (see Checking items) |
| `approved_hashes` | json, null | per item, per check: sha256 of each of its `files` and of the harness files, taken at approval (see Checks) |
| `check_runs` | json, null | the last run of each check: `{ITEM: {CHECK: run}}` |
| `check_flags` | json, null | flags for the owner: weak checks, changed check files, added skips, deleted tests |
| `created_at`, `updated_at`, `started_at`, `finished_at` | integer ms | |

`task_proposal`: a task an agent asked to make, kept apart from tasks so it
takes no number and is in no list until the owner says yes.

| column | type | notes |
|---|---|---|
| `project_id`, `id` | text, integer | the key; `id` counts from 1 per project |
| `session_id` | text | the chat that proposed it |
| `type`, `title`, `why`, `plan` | | as for a task, checked the same way |
| `status` | text | `pending`, `created`, `just_do_it`, `cancelled` |
| `task_number` | integer, null | the task **Create task** made |
| `created_at`, `decided_at` | integer ms | |

`task_event`: `(project_id, number, seq, at, kind, session_id, actor, payload)`.
`actor` is `agent` or `owner`. Every state change appends one row. Kinds:
`created`, `started`, `checked`, `blocked`, `unblocked`, `amended`,
`amend_undone` (older histories: `amend_proposed`, `amend_approved`,
`amend_rejected`), `done`, `submitted`, `approved`,
`reopened`, `cancelled`, `taken`, `released`.

## Lifecycle

```
todo ──start──▶ in_progress ──done──▶ done
  │                │   ▲  │
  │             block unblock  done (review types) ──▶ review ──approve──▶ done
  │                ▼   │                                 └──reopen──▶ in_progress
  │              blocked
  └──────── cancel (from any state but done) ──▶ cancelled
```

- A session holds at most one `in_progress` task. `start` fails otherwise.
- `take N` moves a task to the calling session. If it was `in_progress`
  elsewhere it becomes `todo`. The old session loses it.
- When a session is deleted, its open tasks become unassigned
  (`session_id = null`). Anyone can `take` them.
- The front end shows an `in_progress` task whose session is not running as
  **paused**. This is a display state, not stored.
- Review types (`plan` and the visual types `ui_change`, `ui_feature`, `ui_bug`, `render_change`, `render_feature`, `render_bug`) go to `review` on `done`. The owner
  approves (→ `done`) or reopens with a note (→ `in_progress`; → `todo` if
  the task is unassigned or its session already has another task in progress).
- `amend` applies at once: the plan is replaced and `done` is validated
  against it. The owner can undo the last change (`undo_amend`).
- The owner's approve, reopen and undo answers are told to the chat
  holding the task (see Owner answers).
- Done with an unmet plan item is allowed only with a reason for that item.
  The task is then `done` with `shortfalls = 1`.

### Checking items

For a task with checks, `atelier task check N ITEM` takes no payload: the
server runs the item's checks and ticks it when every one passes (see
Checks). The rest of this section is the rule for tasks made before checks.

`atelier task check N ITEM` records one plan item's result entry while the
task is `in_progress`, so the card ticks items as they are met instead of all
at the end. The entry is the one the type's result has for that item (its
`id` may be left out) and is checked the same way; evidence files are
uploaded as for `done`. Running it again for the same item replaces the
entry. Only the chat holding the task may check, only while it is
`in_progress` (a blocked task is unblocked first). Each check appends a
`checked` event `{item, met, entry, reason?}` and prints the card with
`event: "check"`.

The types with items: `feature` (criteria), `general` (done_when),
`ui_change` (screens), `ui_feature` (screens), `ui_bug` (screens),
`render_change` (scenes), `render_feature` (scenes), `render_bug` (scenes),
`optimization` (targets), `investigation` (questions,
answered in answers), `refactor` (invariants), `tests` (behaviors), `qa`
(scenarios), `docs` (pages), `chore` (steps). `bug`, `plan` and `review`
have none.

- `done` merges the recorded entries into its result; an entry in the done
  payload wins for the same item, so done only has to give the missing ones
  (and the type's other fields). It is refused while any item has no entry,
  naming the open ones. Once done, the result holds them and `checks` is
  cleared.
- An amend drops the entries of items the new plan no longer has and keeps
  the rest; an undo brings them back.

### Proposals

```
propose ──▶ pending ──Create task──▶ created (a todo task in the proposing chat)
               ├──────Just do it───▶ just_do_it
               └──────Cancel───────▶ cancelled
```

- `atelier task propose` checks the draft like `create`, stores it, and prints
  a `task` widget with `event: "propose"`. The agent then stops.
- The card offers the owner **Create task**, **Just do it** and **Cancel**.
  Create task makes a `todo` task (actor `owner`, event payload
  `{proposal: id}`) held by the proposing chat. The other two only record
  the answer.
- Whichever is chosen, the chat's agent is told as a prompt, e.g. `Owner
  chose Create task for proposal "T": task #N created. Start it with …`. If
  the chat is mid-turn the prompt is held and sent when the turn ends; if it
  is not running it is started.
- Deleting the chat cancels its pending proposals.

### Owner answers

When the owner approves or reopens a task in review, or undoes its plan
change, and the action succeeds, the chat holding the task is told
as a prompt, queued like a proposal's answer (held while the chat is
mid-turn, started if it is not running). A task no chat holds tells nobody;
the owner's other actions (`cancel`, `release`) tell nobody.

- **approve**: `Owner approved task #N "T".` and where its commits stand,
  read as for the Merged badge (see Merging) in the holding chat's folder,
  else the project's:
  - on the base already: `Its commits are on main already; nothing is left
    to merge.`
  - not yet: `Its commits are on branch B, not yet on main. Ask the owner
    whether to merge B into main, and don't merge without their yes.` (with
    no branch to name, when the folder is detached or on the base itself:
    `Its commits are not all on main yet. Ask the owner whether to merge
    them into main, …`)
  - no folder, no repository, no base branch or a commit git does not know:
    `Merge state is unknown: its commits or folder could not be read. Check
    whether its commits are on the base branch before asking the owner about
    merging, and don't merge without their yes.`
  - no commits named: `It names no commits, so nothing is left to merge.`

  The agent asks the owner before merging and never merges without the
  owner's yes.
- **reopen**: `Owner reopened task #N "T": NOTE. Continue the work and run
  done again.` (no `: NOTE` when the note is empty). A reopened task left
  `todo` says ``Start it again with `atelier task start N`, continue the
  work and run done again.`` instead.
- **undo_amend**: `Owner undid the plan change for task #N "T": continue
  with the plan as it was before.`

### Reconnect

When a chat connects (opened, resumed or restarted), its session instructions
end with its open tasks and pending proposals, so a resumed agent knows what
it was doing:

```
Your open tasks in this chat:
#4 [in_progress] bug: Export drops the last line
#6 [blocked] feature: CSV export
proposal [awaiting the owner's answer] docs: Document the export
```

Nothing is added when there are none. Open means `todo`, `in_progress`,
`blocked` or `review`.

## Checks

Every plan item and grid cell is defined by one or more checks: shell
commands written before the work that fail now and pass once the item is
met. The owner approves them, the server runs them, and only the server
ticks an item. This is what keeps an agent from declaring an item met, or
from editing a test until it passes.

### A check

```json
{
  "name": "repro",
  "command": "cargo test -p app export_keeps_order",
  "kind": "test",
  "given": "a project with 3 chats", "when": "it is exported", "then": "the chats keep their order",
  "red": "export_keeps_order.*FAILED|assertion",
  "timeout_s": 600,
  "files": ["server/tests/export.rs"],
  "bench": {"value": "p50_ms=([0-9.]+)", "runs": 10, "warmup": 2, "budget": {"max": 0.4, "unit": "ms"}}
}
```

| field | notes |
|---|---|
| `name` | unique within its item, `[a-z0-9-]+` |
| `command` | run with `sh -c` in the task's folder; exit 0 is a pass |
| `kind` | `test`, `benchmark`, `structure` (a grep or file check) or `characterisation` (behaviour that must not change) |
| `given`, `when`, `then` | the behaviour in words; shown on the card |
| `red` | regex the failing output must match at start; not used for `characterisation` |
| `timeout_s` | default 600, at most 3600 |
| `files` | the files the check relies on: its test file, a script, a baseline image. Recorded at approval |
| `bench` | only for `benchmark`: `value` is a regex with one group read from each run's output; `runs` (at least 10) and `warmup`; `budget` is `{max, unit}` (absolute) or `{improve_pct, unit}` (p50 at least that much under the start-of-task baseline) |

Each plan item, under whatever key its type uses (`criteria`, `done_when`,
`screens`, `scenes`, `targets`, `questions`, `invariants`, `behaviors`,
`scenarios`, `pages`, `steps`), has `checks: [Check, …]`, one or more, and
all must pass for the item to be met. A type with no item list (`bug`,
`plan`, `review`) puts them in the plan's own `checks`. `create` and
`propose` refuse an item without a check, or a malformed check.

`atelier task types TYPE` prints, after the plan and result shape, the
type's check recipe: what to check for that kind of work, with one to three
example checks. The recipes live in `server/src/workbench/tasks/recipes.md`.

What makes a good check, in short (the tasks skill says the same to
agents): one observable behaviour per check and as many checks as the item
needs; assert outcomes (return values, DOM, files, HTTP, exit codes), never
that a mock was called, and mock only external boundaries; fail for one
stated reason, the one in `red`; run in under about two minutes.

### Project settings

In the project's manifest:

```toml
[tasks]
harness = ["vitest.config.ts", "package.json", "server/Cargo.toml"]
test_command = "npm test && cargo test"
```

- `harness`: test configuration the checks depend on. It is recorded with
  every check, so the owner sees at done when a task changed the runner
  (excluded a file, changed a timeout, swapped the test script).
- `test_command`: the project's whole suite, run at `done` on top of the
  task's checks. Optional.

### Approval and review

The owner approves every check in one step: **Create task** on a proposal,
an agent's create after the owner's `@task`, approving a grid, or approving
an amend. At that moment the server stores, per item and per check, the
sha256 of each file in `files` and of every harness file
(`approved_hashes`). The check files must therefore exist when the task is
proposed or created; an agent writes them first.

A check file inside a test folder (the topmost ancestor named `tests`,
`test`, `__tests__`, `spec` or `e2e`) also records the other tracked files
in that folder: shared helpers, fixtures, tolerances and baselines. The
other test files there (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.*`,
`*_spec.*`) are left out: they are other tests, which a task's change may
make out of date.

Nothing is locked. An agent may edit any file while it works, including a
check's own file: a Rust test often lives in the same file as the code it
tests. Checks always run as the files are now. The protection is review,
as in SWE-bench and Anthropic's agent guidance, not a lock:

- At done, every recorded file that changed since approval gets a
  `check-file-changed` flag on the review card, naming the file, so the
  owner sees each edit to a check, a helper or the harness.
- When an item's check files changed, `task check` and `done` end with a
  warning to the agent: "Warning: you edited tests/x.rs, which the checks
  use. Make sure each check still tests the real behaviour and was not
  weakened to pass."
- A check cannot pass by running fewer tests. At start the server records
  how many tests each check's output reports (cargo, vitest and pytest
  summaries). A later run that reports fewer fails with, for example,
  "ran 1 test, 3 at start".

Tasks approved under the old lock keep their recorded hashes; those are
now only used for the flags.


### Amend

When a check is wrong or cannot be met, the agent runs `atelier task amend
N` with the whole new plan and a `reason` (what it ran, what it printed).
It applies at once; the owner does not approve it. Once it applies, the
changed checks' files are recorded anew and the changed items are unmet.

A change that may weaken what the owner approved still applies, since the
test can be wrong. The server compares the plans: an item removed, a check
removed, or an approved check changed (its command, files, red pattern or
kind) may weaken it. The reply names each one and asks the agent to make
sure it doesn't, and to amend it back if it does. A change that only adds
says nothing of weakening.

The chat line shows the change and what may weaken, with **Undo change**.
`undo_amend` restores the plan, the stored runs and the recorded entries as
they were before the last change, while the plan is still the one that
change made. It is refused with `no plan change to undo` otherwise.

### Agent rules for checks

The tasks skill tells agents: read the approved checks first; never edit,
delete, skip or rename approved check files, the harness config or
baselines (the server rejects it); implement the behaviour generally, never
branch on test inputs or override equality; make the smallest change to
green and refactor in separate commits; unit-level red-green inside an item
is recommended, not required; file an amend with evidence when a check is
wrong or impossible.

### Grids

Grid columns carry check templates where `{row}` is replaced by the row id.
A cell may add its own checks, or replace the column's with `override:
true`. Approving the grid approves them. A cell with no check is shown as
"Needs a check" and cannot be claimed. Claiming runs the cell's checks red,
and `atelier grid prove` runs them green. See docs/grids.md.

### Notes

The owner or any agent can leave a note on any task in the project, in any
state, done and cancelled included: `atelier task note N --text TEXT`, or
**Add note** on the task card. The agent need not hold the task. A note is a
`note` event (`{text}` payload) and changes nothing else; the text is
required and at most 4000 characters. The task's JSON lists them as `notes:
[{actor, sessionId, at, text}]`, oldest first, and `atelier task show N` and
the task card show them.

### Migration

A task created before checks (no `checks` key anywhere in its plan) keeps
the old rules entirely: `task check` takes the agent's result entry, `done`
takes the item entries, nothing is locked or run. Tasks already started or
in review, and cells already proved, are untouched. New tasks and open cells
use checks.

## Task types

The built-in types are below. The install and each project can add their
own and give any type default items, in `task-types.json`: in the data
folder for the install, and next to the project's manifest for a project.
A project inherits the install's types and items, adds its own, and can turn
a type or an item off (`disabled`, `disabled_items`). The file:

```json
{"types": [{"name": "api_change", "description": "…", "code": true, "review": false}],
 "items": {"ui_change": [{"id": "phone", "text": "Works on a phone screen", "checks": []}]},
 "disabled": ["render_change"], "disabled_items": {"ui_change": ["long-text"]}}
```

Agents change it with `atelier task types create|edit|disable|enable`; each
change keeps the file as it was in `task-types.history.json` under an id,
and `atelier task types undo` (or the owner) puts it back. A change prints a
`taskTypes` card in the chat with **Undo** for that change; the server
refuses it once a later change was made to the scope (`a later change was
made …; undo that first`). Built-in types keep
their shape; only their items change. A custom type is planned and checked
like `general`; its `code` and `review` are kept on each task (`typeDef`)
as they were at create.

Each built-in type has a description that says when to use it (and what
to use instead), and default items (`types.rs`, `TYPES`):

| Type | Default items |
|---|---|
| `bug` | `repro-test`, `same-bug-elsewhere` |
| `feature` | `edge-cases`, `docs-updated` |
| `ui_change`, `ui_feature` | `existing-components`, `screen-sizes`, `ui-copy`, `edge-cases`, `keyboard` |
| `ui_bug` | `repro-test` and the five above |
| `render_change`, `render_feature` | `same-view`, `frame-time`, `artifacts` |
| `render_bug` | `repro-scene`, `same-view`, `frame-time` |
| `optimization` | `measured-runs`, `behaviour-unchanged` |
| `refactor` | `behaviour-unchanged` |
| `tests` | `not-flaky` |
| `docs` | `commands-work` |
| `plan` | `options-weighed` |
| `investigation`, `review`, `qa`, `chore`, `general` | none |

The install or a project turns any of them off with `disabled_items`.

Every create and propose by an agent gives `decisions`: `{TYPE: reason}`
with a non-blank line for every type that is on. The server checks only that
every type is there; the reasons are kept on the task for the owner.

A type's default items are answered in `plan.requirements`, each
`{id, text, checks}` or `{id, text, declined}` (a reason it does not apply).
Agents' creates are refused while one is missing or unanswered. Items with
checks are gate items like the plan's own. A task the owner makes from grid
cells gets the type's items, with their checks copied in; `start` waits
until every other item has checks or a declined reason (`amend`). A task
keeps the items it was created with.

## CLI

All subcommands read the session from `ATELIER_CHAT_SESSION_ID` and the server
from `ATELIER_PORT`. Payloads are JSON on stdin or `--input FILE`. Every
mutating call prints an `atelier-widget` block of type `task` (the card) and a
one-line summary. Errors exit non-zero and say exactly which field is wrong.

```
atelier task types [TYPE]          list the project's types and default items, or print one type's payloads and check recipe
atelier task types create          {name, description, code, review, items?}   a new type (planned like general)
atelier task types edit TYPE       {items?, description?, code?, review?}       items replace the scope's own
atelier task types disable|enable TYPE [--item ID]
atelier task types undo            put the scope's types back as they were before its last change
                                   (every types change takes --scope install|project; project is the default)
atelier task create                {type, title, why, decisions, plan}   only after the owner's @task
atelier task propose               {type, title, why, decisions, plan}   ask the owner instead
atelier task start N
atelier task check N ITEM          run the item's checks and tick it when all pass (old tasks: its result entry)
atelier task block N --cause TEXT --needs TEXT
atelier task unblock N
atelier task amend N               {plan, reason?}
atelier task done N                {summary, commits?, followups?, result}
atelier task cancel N --reason TEXT
atelier task take N
atelier task note N --text TEXT    a note on any task in the project, in any state
atelier task list [--all]          this session's tasks (or the project's)
atelier task show N
```

Shared done fields:

- `summary`: string, required.
- `commits`: array of commit SHAs. Required for types marked *code* below.
  Each must exist in the session's repository.
- `followups`: array of `{type, title, why}`. Suggestions only; the owner can
  turn one into a task from the card.

Evidence fields hold text, `file:line`, a test name, or a path to an image or
video. Paths to images and videos are uploaded like the presenter does and
shown inline: in the stored result the path is replaced by its served
address, `/api/presentation-assets/<sha256>.<ext>`.

## HTTP

JSON is camelCase. A task:

```json
{
  "projectId": "…", "number": 12, "type": "optimization", "title": "…", "why": "…",
  "status": "in_progress", "sessionId": "…", "sessionTitle": "…", "createdBy": "…",
  "plan": {}, "result": null, "shortfalls": false, "blocked": null,
  "cancelReason": null, "pendingAmend": null, "checks": null,
  "createdAt": 0, "updatedAt": 0, "startedAt": null, "finishedAt": null,
  "merged": null,
  "checked": true, "checkRuns": {}, "checkFlags": []
}
```

`checked` is true for a task under the check rules. `checkRuns` is
`{ITEM: {CHECK: {exit, passed, outputTail, commit, at, samples?, value?}}}`;
`checkFlags` is `[{item?, check?, kind, text}]` with `kind` one of `weak`,
`proves-nothing`, `skip-added`, `test-deleted`, `exit-in-test`,
`check-file-changed` (with `path`). Plan items carry their `checks`.

`merged` is only in list and detail responses: `true` when every commit of a
done task is in the base branch, `false` when one is not, `null` when there
are no commits or git could not tell (see Merging).

- `GET /api/workbench/tasks?project=ID[&session=ID]` → `{projectId, tasks: Task[]}`.
  `session` alone gives that session's tasks; `session` with `all=1` gives
  its whole project's (the CLI's `list` and `list --all`).
- `GET /api/workbench/tasks/:project/:number` → `{task, events: TaskEvent[]}`
  (`TaskEvent = {seq, at, kind, sessionId, actor, payload}`)
- `GET /api/workbench/task-types[?session=ID|project=ID]` → `{types: [{name, code, review, custom,
  description, plan, result, items}], off, offInstall}`: the types on for the chat's (or
  the project's) project, or the install's alone, and the types turned off (`offInstall`:
  by the install, which a project cannot turn back on). `plan` and `result` are short
  field descriptions.
- `POST /api/workbench/task-types` with `{session?|project?, change}` → `{summary, widget?}`: a
  types change (`change.action` `create edit disable enable`, or `undo` with `scope` and,
  from a card, the change's `id`). `widget` is the `taskTypes` card
  (`{projectId, scope, summary, change}`) for a change made in a project.
  It sends `taskTypes.changed {projectId, summary}` to the app.
- `POST /api/workbench/task` with `{action, actor, session?, project?, number?, payload?}`
  → `{task, widget, summary}` or `400 {error}`. `actor` is `agent` (the CLI; `session`
  required, project comes from the session) or `owner` (the UI; `project`
  required). Agent actions: `create propose start check block unblock amend done cancel take`.
  `check` takes `{item, entry}` and, like `done`, `files`.
  Owner actions: `approve reopen undo_amend cancel release answer_proposal`.
  `widget` is the fenced `atelier-widget` text the CLI prints.
  `propose` answers `{proposal, widget, summary}`. `answer_proposal` takes
  the proposal id as `number` and `{choice: create|just_do_it|cancel}` as
  `payload`, and answers `{proposal, task, summary}` (`task` is null unless
  the choice was `create`); answering one already answered is a 400.
- `GET /api/workbench/task-proposals/:project/:id` → `{proposal}`, where a
  proposal is `{projectId, id, sessionId, type, title, why, plan, status,
  taskNumber, createdAt, decidedAt}`.
- Every change sends `{type: "tasks.changed", projectId, number}` on the live
  `workbench` feed (the frame also carries `kind: "tasks.changed"`, like the
  feed's other frames). Clients refetch.

The `task` widget is `{type: "task", event, task, detail?}`, where `event`
is the action that produced it and `task` is the snapshot after it.
`detail` is what the change recorded: its event payload without the plans
and the full entry, e.g. a check's `{item, met, reason?}`, a block's
`{cause, needed_to_resume}`, a cancel's `{reason}`. It is left out when
empty (and on cards printed before it existed). A proposal's
widget is `{type: "task", event: "propose", proposal}`, with no `task`.

## Merging

The base branch is the branch `origin/HEAD` points at, else `main`, else
`master`. There is no project setting for it.

- **Merged badge.** A done task with commits shows **Merged** or **Not
  merged**: whether every commit is an ancestor of the base branch
  (`git merge-base --is-ancestor`), asked in the holding (or creating)
  chat's folder, else the project's folder. Answers are cached by
  repository, base tip and commit, so a moved base is asked again.
- **`@merge`** in the composer (the `@` menu's "Merge branch" line) is the
  owner asking the agent to merge the chat's branch into the base branch.
  Like `@task` it is a bare word; `@merge:…` is nothing. When the message is
  sent the server adds what git says about the chat's folder (repository,
  current branch, base branch, the worktree that has the base checked out
  and whether it is clean) and the steps: commit this chat's own uncommitted
  work, merge the base into the branch (never rebase: tasks name their
  commits, and merged is read from ancestry) and re-run the tests,
  fast-forward the base (`git -C <base checkout> merge --ff-only <branch>`,
  or `git fetch . <branch>:<base>` when the base is not checked out), never
  push, and report where the base now points. If the folder is not a repository, has no base branch, is on a
  detached HEAD or on the base itself, or the base checkout has uncommitted
  changes, it says so and tells the agent to stop and tell the owner.

## Types

Lists in a plan have an `id` (string, unique in the list). Each result list
must have exactly one entry per plan id.

Anything you can see on screen or in a render uses a visual type:
`ui_change`, `ui_feature`, `ui_bug`, `render_change`, `render_feature` or
`render_bug`. New work you can see is `ui_feature` or `render_feature`,
not `feature`. A bug you see in the app's interface is `ui_bug`; a bug in
what a 3D scene renders is `render_bug`; neither is `bug`.

The old visual-bug type was split into those two. The server renames its
stored tasks and proposals to `ui_bug` at start (they were all bugs on a
screen), and the front end draws one of its cards saved in a chat as a
`ui_bug` (`LEGACY_TYPES`).

### `bug` (code)
- plan: `symptom`, `repro_steps[]`, `expected`, `actual`, `suspected_area?`
- result: `root_cause`, `fix`, `proof` (evidence that it failed before and passes after), `regression_checked[]`, `screens[]? {name, before?, after}` (see Visual files)

### `feature` (code)
- plan: `outcome`, `criteria[] {id, text}`
- result: `criteria[] {id, met, evidence, reason?}` (`reason` required when not met), `screens[]? {name, before?, after}` (see Visual files)

### `ui_change` (code, review)
- plan: `screens[] {id, name, how_to_reach, change}`
- result: `screens[] {id, before, after, notes?}` (`before` and `after` are images, see below)

### `ui_feature` (code, review)
- plan: `outcome`, `screens[] {id, name, how_to_reach, shows, existed?}`
  (`shows`: what the screen must show; `existed: true`: the screen was
  already there)
- result: `screens[] {id, after, before?, notes?}`. `before` is required for
  a screen whose plan item says `existed: true`; a new screen has only an
  `after`.

### `ui_bug` (code, review)
- plan: the `bug` fields (`symptom`, `repro_steps[]`, `expected`, `actual`, `suspected_area?`) and `screens[] {id, name, how_to_reach}`
- result: `root_cause`, `fix`, `screens[] {id, before, after, notes?}`

### `render_bug` (code, review)
- plan: the `bug` fields and `scenes[] {id, scene, camera, reference?}`
- result: `root_cause`, `fix`, `scenes[] {id, before, after, reference?, notes?}`
  (`before` renders the bug, `after` the same scene and camera fixed)

### `render_change` (code, review)
- plan: `scenes[] {id, scene, camera, change, reference?}` (`reference: true` asks for a reference image of that scene)
- result: `scenes[] {id, before, after, reference?, notes?}`. `reference` is
  optional, and required for a scene whose plan item says `reference: true`.

### `render_feature` (code, review)
- plan: `outcome`, `scenes[] {id, name, scene, camera, shows, existed?, reference?}`
- result: `scenes[] {id, after, before?, reference?, notes?}`. `before` is
  required where the plan item says `existed: true`, `reference` where it
  says `reference: true`.

### Before and after images

For the visual types, `check` and `done` are refused unless each item's
`after`, its `before` (always for `ui_change`, `ui_bug`,
`render_change` and `render_bug`; where the screen or scene existed for `ui_feature` and
`render_feature`) and a `reference` (where given or asked for) are images
uploaded as presentation assets: the CLI uploads files named in the
payload, and the server stores them as
`/api/presentation-assets/<sha256>.<ext>`. A path that is missing or not a
PNG, JPEG, GIF or WebP is refused, and so are a `before` and `after` with
the same contents (the same hash). The same rule holds for the screenshots
on a `feature` or `bug` result.

### Visual files

The safety net under `feature` and `bug`: `done` is refused when any of its
commits change a visual file, unless the result has `screens[] {name,
before?, after}` (screenshots, held to the image rule above; `before` where
the screen existed). The error names the files, the `screens` field and the
visual types to use instead. The changed files are read with git
(`git diff-tree --name-only -r --root <sha>`) in the session's folder.

Visual files are, by default, `.tsx .jsx .css .scss .html .vue .svelte` and
shaders (`.wgsl .glsl .hlsl .frag .vert .comp .metal .slang`). Tests never
count: anything under `__tests__` or named `*.test.*` or `*.spec.*`. A
project replaces the list in its manifest (`.atelier/project.toml` or its
personal one), with extensions or globs over the path from the repository's
root:

```toml
[tasks]
visual_files = [".tsx", ".css", "assets/**/*.svg"]
```

### `optimization` (code)
- plan: `targets[] {id, name, metric, unit, baseline, target, how_measured, environment, higher_is_better?}`. `baseline` and `target` are numbers; lower is better unless `higher_is_better` is true.
- result: `method`, `targets[] {id, before, after, runs, why_faster?, failure_reason?}`. The server works out `met` from `after` and `target`; `why_faster` is required when met, `failure_reason` when not.

### `plan` (review)
- plan: `question`, `scope`, `constraints[]`
- result: `document` (markdown), `decisions[]`, `open_questions[]`, `proposed_tasks[] {type, title, why}`

### `investigation`
- plan: `questions[] {id, text}`
- result: `answers[] {id, answer, evidence[], confidence: low|medium|high, recommendation?}`

### `refactor` (code)
- plan: `change`, `reason`, `invariants[] {id, text}`
- result: `invariants[] {id, how_verified}`, `files_changed`, `net_lines`, `deviations[]`

### `tests` (code)
- plan: `behaviors[] {id, text}`
- result: `behaviors[] {id, test_path, test_name, fails_without_code, reason?}` (`reason` required when `fails_without_code` is false)

### `review`
- plan: `target` (diff, branch or commit range), `focus[]`
- result: `verdict: approve|changes_needed`, `findings[] {severity: high|medium|low, location, summary, failure_scenario}`

### `qa`
- plan: `scenarios[] {id, steps[], expected}`
- result: `scenarios[] {id, passed, evidence, notes?}` (`notes` required when not passed)

### `docs` (code)
- plan: `audience`, `pages[] {id, path, change}`
- result: `pages[] {id, path, what_changed}`

### `chore` (code)
- plan: `steps[] {id, text}`
- result: `steps[] {id, done, output?, reason?}` (`reason` required when not done)

### `general`
- plan: `outcome`, `done_when[] {id, text}`
- result: `done_when[] {id, met, evidence, reason?}`

## Agent rules (go in the session instructions)

1. Questions, explanations and single small edits never need a task. Work
   that changes several files or takes several steps does. If such a request
   is not already a task, run `atelier task propose` and stop; continue when
   the owner's choice arrives.
2. `@task <text>` from the owner means: pick the type, draft the plan, run
   `atelier task create`. Don't ask again.
3. Plans are test-first: every item carries checks written before the
   work. Start the task before working on it; start runs the checks red.
   Run `atelier task check` for each item as its checks turn green, not all
   at the end. Block only for a cause outside your control. Finish it with
   `done`. Never leave it in progress at the end of the work.
4. Plan and check changes go through `amend`. Never change scope silently,
   and never edit an approved check file.
   The owner's approve, reopen and undo answers arrive as messages;
   after an approval, ask before merging and never merge without the
   owner's yes.
5. Follow-ups are suggestions on the result, not new tasks.

## Front end

- **Task card in a chat** (widget type `task`, `event: "create"`): the one
  card a task prints. Header with `#N`, type, title, status and a met count;
  the plan's items one line each, cut short with an ellipsis (the whole text
  is the tooltip and is in the detail), five at most until **Show all N**.
  Ticked live as items are checked; an item under the check rules shows
  `2 of 3 checks pass` until all do, and its checks (Given/When/Then and the
  command, with the last run) unfold under it. A type without plan items (`bug`,
  `plan`, `review`) shows its short plan. Clicking the title opens the detail.
- **Event lines**: every later change (`start`, `check`, `block`, `unblock`,
  `take`, `amend`, `done`, `cancel`, `approve`, `reopen`, `undo_amend`,
  `release`) is one line: an icon, `#N` and what happened,
  e.g. `Checked “Button works” — met`, `Blocked: <cause>`,
  `Plan changed: +1 criterion “…”`, `Done · 6 of 7 met · 1 missed`. While the
  task (live) still waits on the owner for a done, its buttons sit on
  the line (Approve / Reopen); once answered they go and the line says how
  it was answered. A plan change unfolds to its diff, its reason and what it
  may weaken, with **Undo change** while the plan is still the one it made;
  once undone the line says `Undone`. A done line unfolds to the done summary; a done line starts folded
  unless it waits for review. A visual type's check unfolds to its images.
  Clicking the line (not its buttons) opens the task's detail in the Tasks
  tab as a new history entry, so Back returns to the chat.
- **Plan change diff**: only the items added, removed and changed (matched
  by id in the type's plan list) and the other top-level fields that
  changed, never both whole plans. The same in an event line and in the
  detail's pending change panel.
- **Done summary**: met and missed counts, the check flags (proves
  nothing, added skips, deleted tests, exit calls in tests), only the missed items with their
  reasons, root cause and fix for `bug`, `ui_bug` and `render_bug`, the summary, and
  the commits with the Merged badge, and a `feature` or `bug` result's
  screenshots behind their toggles. The whole result per type
  (optimization as a before/after/target table, the visual types as image
  compares, plan as rendered markdown) is behind **Show all**. Used in the
  done line and the detail.
- **Images**: a visual type's before and after images sit side by side
  behind a toggle (with the reference for `render_change` and
  `render_feature`), so they take no room until opened. An item with no
  before (a new screen or scene) shows its after alone.
- **Checklist panel**: the current session's tasks with live statuses and,
  for a task with plan items, how many are met (`3/7`); an active task lists
  its plan items ticked, missed or open. A task's row opens its detail on
  the Tasks tab.
- **Tasks tab** on the project screen, on every project: tasks grouped by
  status, filters for session and unassigned, a detail panel with history,
  and owner actions: approve or reopen (review),
  cancel, release (unassign), and turn a follow-up into a task (this puts
  `@task <type>: <title> — <why>` in the composer of a chat).
- **`@task`** in the composer: a menu entry that inserts `@task `. `@task:N`
  references an existing task.
- **Proposal card** (a `task` widget with `event: "propose"`): the draft and
  its plan, each item's checks folded under it with any weak-check flags, with **Create task**, **Just do it** and **Cancel** while it
  waits, and what became of it once answered. It rereads the proposal on
  `tasks.changed`, so an answer given elsewhere shows.
- **Merged badge** on a done task's card, next to its commits.
- **Why this type**: a fold under a task's or proposal's header with the
  agent's reason for each type, its own type's first.
- **Custom types and default items**: a custom type's plan is drawn like
  the type it is planned as (`shape`). A type's default items
  (`plan.requirements`) are listed after the plan's own: those with checks
  tick like any item, declined ones show their reason and are not counted.
- **Types change card** (widget type `taskTypes`): one line saying what
  changed, with **Undo** for that change, `Undone` once undone, or the
  server's reason when it is refused.
- **Settings > Task types**, and **Task types** in a project's settings:
  every type with its description and default items, custom types marked,
  and a switch that turns it on or off for all projects or the project.
  `general` stays on; a type the install turned off shows `Off for all
  projects` in a project.
- **`@merge`** in the composer: "Merge branch" in the `@` menu, offered
  while what is typed after `@` starts "merge".
