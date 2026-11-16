# Workflows

Tasks #35, #38, #39, #43, #45, #46 and #48. A workflow takes an item, such as a Linear ticket,
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
- **Agent:** the provider and account each run's chat starts on, with a
  model and an effort (**Default** leaves either to the account). It is kept
  as `agent: {brand, profile_id, model, effort}`; `profile_id` is left out
  for the provider's own sign-in. A workflow without an agent refuses to
  start, and its schedule skips it.
- **Runs at once** (`max_concurrent`, 1 when unset): how many runs may work
  at the same time. More runs wait with status **Queued**.
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

1. **Start.** The owner clicks **Run**, picks items and clicks **Start**. The
   dialog starts from the workflow's agent and may pick another for these
   runs only. A schedule can also start runs on its own (see below). Every
   new run is **Queued** first. While fewer than **Runs at once** runs hold a
   slot, the server starts the oldest queued run. Only a working agent holds
   a slot: a run that has a chat and is **Running**. A run that **Needs you**,
   a run on a Wait stage, and a run that finishes or is stopped hold none.
   When the owner continues a run and every slot is taken, the run is
   **Queued** again and takes the next free slot before any new item. For each
   started item, the server finds the worktree already on the item's branch, or makes one. A
   branch that exists neither locally nor on `origin` is created from the
   base. The server then opens a chat on the run's agent in that worktree, named after
   the item, and enters the first stage.
2. **Agent stages.** The prompt is sent with the item's details filled in,
   and with a closing note on how to report the stage (see **Reporting a
   stage**):

   ```
   This chat is running the workflow "Linear work", stage "QA" (2 of 8). Run
   `atelier workflow show` to see every stage and where each outcome leads.
   When this stage is finished, run one of these commands, then end your reply:
   atelier workflow done pass
   atelier workflow done fail
   If you cannot finish without the owner, run
   `atelier workflow block --needs "what you need"` and end your reply.
   ```

   When the chat's turn ends, the server takes the route for the outcome the
   agent reported. If the outcome matches no route, the run stops for the
   owner.
3. **Wait stages** rerun their check once a minute, on the same tick that
   polls schedules. A check usually asks an outside system about the item,
   for example a Linear query that prints the ticket's state. Routes such as
   `Rejected` or `Needs merging to staging` then pick the next stage.
4. **Finish.** A stage with no routes ends the run with status **Done**.
   **Stop** ends it with status **Stopped**, and the server ignores that
   chat from then on.

5. **A stage cut off.** When the app shuts down (with the computer, say) or
   an agent dies, a run on an agent or command stage loses its work. Every
   tick looks at each **Running** run. If its chat has no agent running, or
   its command is not running in this app, the run follows an outcome the
   agent reported before it stopped. Otherwise it enters the stage again:
   the prompt is sent to the chat, which starts its agent, or the command
   runs again. That counts as an attempt, so a stage that keeps dying stops
   for the owner. A chat whose agent is still there but whose turn ended on
   an error or a stop waits for the owner. When the owner stops a run's chat
   by hand, the run waits for them with "You stopped the chat" and is not
   started again.

A run's chat shows the stage it is on as a badge, in the chat's badge bar
and on its sidebar row (`src/workbench/workflow-stage-chip.tsx`). Pointing at
it names the workflow and the step, such as "Ticket flow workflow, stage 2 of
5". The badge follows the run every few seconds and goes away when the run is
done or stopped.

Statuses: **Queued**, **Running**, **Waiting** (a Wait stage), **Needs you**, **Done**
and **Stopped**. A run that needs the owner shows why. **Continue** passes
an Approval stage, or sends any other stage's prompt again with its attempt
count reset.

## Reporting a stage

A run's agent uses `atelier workflow` from its chat. Like `atelier task`, it
names the chat with `ATELIER_CHAT_SESSION_ID` and talks to the running app.

- `atelier workflow show` prints the whole workflow: every stage, where each
  outcome leads, the current stage and the outcomes it accepts.
- `atelier workflow done OUTCOME` finishes the current stage. An outcome the
  stage has no route for is refused, with the stage's outcomes listed, and
  so is `done` while a task the chat holds is still in progress. The server
  keeps the outcome and acts on it when the turn ends.
- `atelier workflow wait --minutes N --for TEXT` waits inside the stage for
  something that takes minutes, such as a review bot or CI. N is 1 to 60.
  When the turn ends, the run shows **Waiting** with "Checks again at HH:MM:
  TEXT" and gives up its slot. Once the time is up and a slot is free, the
  chat is told to check TEXT again, with the commands for reporting. The
  wait is kept on the run, so it survives a restart; a chat gone by then is
  sent its stage again. A longer wait is refused: something that takes
  hours, such as QA testing the ticket, is outside the stage. The agent
  reports `done`, and a Wait stage after it checks for it.
- `atelier workflow block --needs TEXT` stops the run for the owner at once.
  The run shows **Needs you** with that text and gives up its slot.

Only these commands move a run. Nothing is read from the agent's reply.

**Reminders.** A turn that ends with no report, no task proposal and no task
in review gets a reminder: "This chat ended its turn without reporting stage
…", with every command. After two reminders in a row, the next such turn
puts the run on **Needs you** with "The agent ended its turn 3 times in a row
without reporting the stage". Reminders count from zero again when the agent
reports or a stage starts. A turn that ends while the agent waits on its own
subagents is left alone; its turn ends for real later. Matching outcomes
ignores case.

## Automatic switches

Each agent stage has three switches. All are off by default. With a switch
off, the run stops for the owner at that point.

- **Approve plan:** when the agent proposes a task, the server answers
  **Create task** for the owner, exactly as the owner's own click would.
- **Approve finished work:** when the stage's task is waiting for review,
  the server approves it. The chat is told only "The workflow approved task
  #N", with nothing about merging: what happens next is up to the
  workflow's stages.
- **Answer questions:** the reminder for a turn that ends with no report,
  which usually means the agent asked something, also tells the agent to use
  its best judgment, say what it chose and carry on. With the switch off,
  the reminder says to ask the owner with `atelier workflow block`.

These checks run in that order whenever a turn ends: a `block` first, then a
waiting proposal, then a task in review, then a wait, then the outcome, then
a reminder. A wait or an outcome reported in the same turn as a task in
review still applies after the server approves the task.

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

`GET /api/workbench/workflow-stages` returns `{chats: {SESSION: {run,
workflow, stage, step, steps, status}}}` for every run that is not done or
stopped, with the workflow's and stage's names. The stage badges read it.

`POST /api/workbench/workflow-runs` takes an `action`:

| Action | Body | Answer |
|---|---|---|
| `items` | `projectPath`, `workflow` | `{items}`, or 422 with the command's error |
| `start` | `projectId`, `projectPath`, `workflow`, `items`, optional `agent` | `{runs}`; refused when neither the body nor the workflow has an agent |
| `continue` / `stop` | `run` | `{run}` |
| `tick` | `projectPath`, `projectId` | `{ok}`; runs the checks and schedules now |

`POST /api/workbench/workflow-run` is what `atelier workflow` sends. Every
body names the chat with `session`, and the chat must be running a stage.

| Action | Body | Answer |
|---|---|---|
| `show` | | `{workflow, item, current, outcomes, status, stages}` |
| `done` | `outcome` | `{summary}`; 400 for an outcome the stage has no route for, 409 while the chat's task is in progress |
| `wait` | `minutes`, `for` | `{summary}`; 400 for fewer than 1 or more than 60 minutes, or no `for` |
| `block` | `needs` | `{summary}`; the run is **Needs you** with `needs` as its note |
