# Workflows

Tasks #35 and #38. A workflow takes an item, such as a Linear ticket,
through a fixed set of stages. Each item gets its own worktree and chat, and
the server moves it from stage to stage. The owner steps in only where the
workflow says so.

## Where it lives

- **Settings:** Project settings > Workflows. The list and the editor are in
  `src/components/settings/workflows-*.tsx`. The editor's **Run** button and
  **Runs** list are in `workflow-runs.tsx`.
- **Storage:** workflows are kept in `workflows.json` beside the project's
  `library.json` (`server/src/workbench/workflows.rs`). They are read and
  saved through `/api/settings/workflows`.
- **Runs:** each run is a row in the `workflow_run` table, kept in the chat
  database. The engine is `server/src/routes/workbench/workflow_runs.rs`,
  served at `/api/workbench/workflow-runs`.

## A workflow

- **Trigger:** either **Manual** or **Schedule** (every N minutes). The
  **Items command** is a shell command that runs in the project folder and
  prints the items as a JSON list. Each item is an object, for example
  `{"identifier": "KEY-1", "title": "Fix login", "branchName": "feature/key-1"}`.
  An item's key is its `identifier`, `id`, `key`, `branchName` or `url`, in
  that order.
- **Worktree:** the branch, with `{{item.…}}` placeholders, and the base
  branch that a new branch starts from.
- **Stages:** run in order of their routes, starting with the first. Each
  stage has a kind:

| Kind | What the server does |
|---|---|
| Agent | Sends the stage's prompt to the run's chat and waits for the turn to end. |
| Command | Runs the prompt as a shell command in the worktree. Success reports `done`, failure reports `failed`. |
| Wait | Runs the prompt as a check now and on every tick. The run moves on when a line of output equals one of the routes' outcomes. |
| Approval | Stops with status **Needs you** until the owner clicks **Continue**. |

- **Routes:** each route maps an outcome to the next stage. A stage with no
  routes finishes the run.
- **Max attempts:** if a stage is entered more than this many times, the run
  stops for the owner. This catches a loop such as QA failing again and
  again.

## How a run goes

1. **Start.** The owner clicks **Run**, picks items and clicks **Start**. A
   schedule can also start runs on its own (see below). For each item, the
   server finds the worktree already on the item's branch, or makes one. A
   branch that exists neither locally nor on `origin` is created from the
   base. The server then opens a Claude chat in that worktree, named after
   the item, and enters the first stage.
2. **Agent stages.** The prompt is sent with the item's details filled in,
   and with a closing note that lists the outcomes the stage accepts:

   ```
   This chat is running the workflow "Linear work", stage "QA". When this stage
   is finished, end your reply with one of these lines, exactly as written:
   Outcome: pass
   Outcome: fail
   ```

   When the chat's turn ends, the server reads the last `Outcome:` line in
   the agent's newest reply and takes the matching route. Matching ignores
   case. If the outcome matches no route, the run stops for the owner.
3. **Wait stages** rerun their check once a minute, on the same tick that
   polls schedules. A check usually asks an outside system about the item,
   for example a Linear query that prints the ticket's state. Routes such as
   `Rejected` or `Needs merging to staging` then pick the next stage.
4. **Finish.** A stage with no routes ends the run with status **Done**.
   **Stop** ends it with status **Stopped**, and the server ignores that
   chat from then on.

Statuses: **Running**, **Waiting** (a Wait stage), **Needs you**, **Done**
and **Stopped**. A run that needs the owner shows why. **Continue** passes
an Approval stage, or sends any other stage's prompt again with its attempt
count reset.

## Automatic switches

Each agent stage has three switches. All are off by default. With a switch
off, the run stops for the owner at that point.

- **Approve plan:** when the agent proposes a task, the server answers
  **Create task** for the owner, exactly as the owner's own click would.
- **Approve finished work:** when the stage's task is waiting for review,
  the server approves it.
- **Answer questions:** when a turn ends with no outcome, which usually means
  the agent asked something, the server tells the agent to use its best
  judgment, say what it chose and carry on.

These checks run in that order whenever a turn ends: a waiting proposal
first, then a task in review, then the outcome.

## Schedules

On every tick, each enabled **Schedule** workflow that is due runs its Items
command. It starts one run for each item whose key has no run yet in that
workflow, so an item is never started twice. Manual workflows and disabled
workflows never start on their own. A failing Items command is logged and
tried again on the next due tick. In the Run dialog, the same failure shows
its error and disables **Start**.

## API

`GET /api/workbench/workflow-runs?projectPath=` returns `{runs: [...]}`,
newest first.

`POST /api/workbench/workflow-runs` takes an `action`:

| Action | Body | Answer |
|---|---|---|
| `items` | `projectPath`, `workflow` | `{items}`, or 422 with the command's error |
| `start` | `projectId`, `projectPath`, `workflow`, `items` | `{runs}` |
| `continue` / `stop` | `run` | `{run}` |
| `tick` | `projectPath`, `projectId` | `{ok}`; runs the checks and schedules now |
