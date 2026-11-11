# Tasks

Tasks replace Beads. A task is a piece of work owned by the app, tied to the
chat session that holds it, with a type that decides what the agent must
promise when it creates the task and what it must prove when it finishes.

## Principles

- The app owns tasks. There is no separate board to keep in sync, no hooks
  that police it, and no landing step. The only way to change a task is the
  `atelier task` CLI (agents) or the Tasks screen (the owner).
- Agents work in the worktree the owner opened the session in. They never
  create worktrees or branches for a task.
- Agents never create a task on their own initiative. The owner asks with
  `@task`, or the agent asks "make this a task?" and the owner says yes.
- Each type has a plan (given at create) and a result (given at done). The
  server rejects a result that does not cover the plan.
- "Done" means the result is accepted, and for code-changing types that the
  named commits exist in the session's repository. Merging is separate and is
  the owner's business.

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
| `pending_amend` | json, null | a proposed new plan waiting for the owner |
| `created_at`, `updated_at`, `started_at`, `finished_at` | integer ms | |

`task_event`: `(project_id, number, seq, at, kind, session_id, actor, payload)`.
`actor` is `agent` or `owner`. Every state change appends one row. Kinds:
`created`, `started`, `blocked`, `unblocked`, `amend_proposed`,
`amend_approved`, `amend_rejected`, `done`, `submitted`, `approved`,
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
- Review types (`plan`, `ui_change`) go to `review` on `done`. The owner
  approves (→ `done`) or reopens with a note (→ `in_progress`; → `todo` if
  the task is unassigned or its session already has another task in progress).
- `amend` stores `pending_amend`. The owner approves (plan replaced) or
  rejects. `done` is validated against the approved plan.
- Done with an unmet plan item is allowed only with a reason for that item.
  The task is then `done` with `shortfalls = 1`.

## CLI

All subcommands read the session from `ATELIER_CHAT_SESSION_ID` and the server
from `ATELIER_PORT`. Payloads are JSON on stdin or `--input FILE`. Every
mutating call prints an `atelier-widget` block of type `task` (the card) and a
one-line summary. Errors exit non-zero and say exactly which field is wrong.

```
atelier task types [TYPE]          list types, or print one type's plan and result shape
atelier task create                {type, title, why, plan}
atelier task start N
atelier task block N --cause TEXT --needs TEXT
atelier task unblock N
atelier task amend N               {plan}
atelier task done N                {summary, commits?, followups?, result}
atelier task cancel N --reason TEXT
atelier task take N
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
  "cancelReason": null, "pendingAmend": null,
  "createdAt": 0, "updatedAt": 0, "startedAt": null, "finishedAt": null
}
```

- `GET /api/workbench/tasks?project=ID[&session=ID]` → `{projectId, tasks: Task[]}`.
  `session` alone gives that session's tasks; `session` with `all=1` gives
  its whole project's (the CLI's `list` and `list --all`).
- `GET /api/workbench/tasks/:project/:number` → `{task, events: TaskEvent[]}`
  (`TaskEvent = {seq, at, kind, sessionId, actor, payload}`)
- `GET /api/workbench/task-types` → `{types: [{name, code, review, plan, result}]}`
  where `plan` and `result` are short field descriptions for `atelier task types`.
- `POST /api/workbench/task` with `{action, actor, session?, project?, number?, payload?}`
  → `{task, widget, summary}` or `400 {error}`. `actor` is `agent` (the CLI; `session`
  required, project comes from the session) or `owner` (the UI; `project`
  required). Agent actions: `create start block unblock amend done cancel take`.
  Owner actions: `approve reopen approve_amend reject_amend cancel release`.
  `widget` is the fenced `atelier-widget` text the CLI prints.
- Every change sends `{type: "tasks.changed", projectId, number}` on the live
  `workbench` feed (the frame also carries `kind: "tasks.changed"`, like the
  feed's other frames). Clients refetch.

The `task` widget is `{type: "task", event, task}`, where `event` is the
action that produced it and `task` is the snapshot after it.

## Types

Lists in a plan have an `id` (string, unique in the list). Each result list
must have exactly one entry per plan id.

### `bug` (code)
- plan: `symptom`, `repro_steps[]`, `expected`, `actual`, `suspected_area?`
- result: `root_cause`, `fix`, `proof` (evidence that it failed before and passes after), `regression_checked[]`

### `feature` (code)
- plan: `outcome`, `criteria[] {id, text}`
- result: `criteria[] {id, met, evidence, reason?}` (`reason` required when not met)

### `ui_change` (code, review)
- plan: `screens[] {id, name, how_to_reach, change}`
- result: `screens[] {id, before, after, notes?}` (`before` and `after` are image paths)

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
   is not already a task, ask with a choice: **Create task / Just do it /
   Cancel**. Create only after "Create task".
2. `@task <text>` from the owner means: pick the type, draft the plan, run
   `atelier task create`. Don't ask again.
3. Start the task before working on it. Block it only for a cause outside
   your control. Finish it with a full result. Never leave it in progress at
   the end of the work.
4. Plan changes go through `amend`. Never change scope silently.
5. Follow-ups are suggestions on the result, not new tasks.

## Front end

- **Task card** (widget type `task`): header with `#N`, type, title and
  status; the plan rendered per type; once done, the result per type
  (optimization as a before/after/target table, ui_change as image compares,
  plan as rendered markdown). The status chip is live.
- **Checklist panel**: the current session's tasks with live statuses,
  replacing the Beads epic checklist.
- **Tasks tab** on the project screen, replacing Board: tasks grouped by
  status, filters for session and unassigned, a detail panel with history,
  and owner actions: approve or reopen (review), approve or reject an amend,
  cancel, release (unassign), and turn a follow-up into a task (this puts
  `@task <type>: <title> — <why>` in the composer of a chat).
- **`@task`** in the composer: a menu entry that inserts `@task `. `@task:N`
  references an existing task.
