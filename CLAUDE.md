# Agent Instructions

This project uses Beads for durable task tracking. Run `bd prime` before work.

<!-- BEGIN ATELIER WORKFLOW -->

## Atelier workflow (managed)

Atelier uses one shared Beads board. A worktree isolates code; it does not create another board.

For every repository file change, use this path. Do not substitute generic
`bd create`, `git worktree add`, `bd close`, or a guessed board command.

1. From the main checkout, create the job with the existing job command. Use
   `--size small --do "WHAT|CHECK"` for one independently verifiable outcome;
   otherwise omit `--do` and pour each outcome afterward with
   `machinery/board/job under <job-id> --do "WHAT|CHECK"`:

   ```bash
   machinery/board/job new --what "OBSERVABLE OUTCOME" --evidence "WHY IT IS REAL NOW" --done "COMMAND reports EXPECTED RESULT" --not "NAMED OUT-OF-SCOPE FILE OR SYSTEM" --area AREA --kind bug|feature|chore --size small|medium|large --judge agent="WHAT SETTLES IT" --alone "WHY NO OPEN JOB OWNS IT" -p 2
   ```

2. Still from the main checkout, make the job's one worktree. All of its work
   items use this same tree; never make a tree for a child:

   ```bash
   git -C . worktree add worktrees/<job-id> -b <job-id>
   ```

3. From that worktree, claim the work item in a command of its own, then edit:

   ```bash
   cd worktrees/<job-id>
   bd update <work-id> --claim
   ```

4. Run the work item's stated check, commit the result with every work-item ID
   in the commit subject, and land it from that same worktree:

   ```bash
   git commit -m "<work-id>: OUTCOME"
   machinery/board/land <card-id>
   ```

5. After the work lands, follow the step the board opens; do not invent it:

   - For `Checks:`, run `machinery/checks <checks-id>` from the worktree. It
     runs the declared suites, records their exact result, and closes the step.
   - Review starts automatically. If it files findings, claim each finding,
     fix and commit it, then run the same land command with the finding's ID.
   - For any later open child, use `bd list --parent <job-id> --all`, follow
     that child's acceptance criterion, and use the command named on the card.

   Stop only when `bd show <job-id>` says the job is closed or asks for manager
   judgment.

The lifecycle gates are authoritative. Tests alone do not finish work, and a
direct status change never replaces commit, independent review, landing, or
closure.

## Isolated app instances

Never run development or proof work against the owner's Atelier instance on
port 3008, its backend, its helper, or its data. Every job worktree owns a
separate disposable stack, including frontend/backend, workbench helper, data,
configuration, fixture projects, and processes.

Before starting a stack, allocate two currently unused TCP ports unique to the
worktree: one for Atelier and one for its helper. Do not reuse fixed example
ports such as 3018/3019, and do not borrow ports from another worktree. Export
both ports, explicitly set `ATELIER_PORT` to the first, and give the run a
worktree-specific directory:

```bash
export BEADS_WEB_PORT="<free-port-for-this-worktree>"
export ATELIER_PORT="$BEADS_WEB_PORT"
export BEADS_WORKBENCH_PORT="<different-free-port-for-this-worktree>"
export WORKBENCH_E2E_RUN="$PWD/tests/.e2e-run-<job-id>"
scripts/workbench-e2e.sh <spec> [playwright arguments]
```

The two selected ports must be probed immediately before startup and startup
must fail if either is occupied. `ATELIER_PORT` is mandatory: without it the
backend's installed-service guard can target the owner's port 3008 even when
`BEADS_WEB_PORT` is set. Use `scripts/workbench-e2e.sh` when possible; it gives
the run isolated XDG/Claude/session data and removes only the processes on its
two declared ports. For a manual stack, record every child PID at launch, use
worktree-specific data/config directories, and install an EXIT trap that stops
only those recorded PIDs. Never use `pkill`, `killall`, process-name matching,
or cleanup by a shared/default port.

When the proof ends, verify both allocated ports are free. Do not stop, start,
restart, install, or reload the owner's app or any process you did not launch.

## Visual proof in chat

For every visual change, capture the relevant screen before editing and again
after the change, then include both images in the conversation as an
`atelier-image-compare` block. For a newly added visual with no meaningful
before state, capture and include the finished result as an ordinary inline
image. Do this before handing the work back; do not wait for the manager to ask.

## Useful widgets in chat

Use an `atelier-widget` fenced block when a structured visual makes the result
faster to understand than prose. Use `metrics` for 2–6 headline values,
`chart` with `bar` for category comparisons or `line` for trends, `progress`
for bounded completion, `timeline` for ordered events, and `table` for exact
side-by-side facts. Do not use a widget for one fact or a short list.

The block contains one object. Common fields are `type` and optional `title`.
The five accepted shapes are:

- `metrics`: `items` with `label`, `value`, and optional `detail`/`trend`.
- `chart`: `chart`, `series` (`name`, optional `color`), and `data` (`label`,
  numeric `values` in series order).
- `progress`: `items` with `label`, numeric `value`, optional `max`/`detail`.
- `timeline`: `items` with `label`, optional `detail`, and optional `status`
  (`done`, `current`, or `next`).
- `table`: `columns` and equally sized string `rows`.

<!-- END ATELIER WORKFLOW -->
