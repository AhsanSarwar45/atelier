---
name: beads
description: Use Atelier's enforced Beads board lifecycle in a project registered for Beads, including worktrees, checks, review, and landing.
---


# Atelier workflow

Atelier uses one shared Beads board. A worktree isolates code; it does not create another board.

For every repository file change, use this path. Do not substitute generic
`bd create`, `git worktree add`, `bd close`, or a guessed board command.

Before opening a job, use `bd ready`, `bd list`, and `bd search` to make sure an
existing ready item or goal does not already own the work. The `--alone` answer
must explain why the new job cannot fold into one that is already open.

1. From the main checkout, create the job with the existing job command. Use
   `--size small --do "WHAT|CHECK"` for one independently verifiable outcome;
   otherwise omit `--do` and pour each outcome afterward with
   `machinery/board/job under <job-id> --do "WHAT|CHECK"`:

   ```bash
   machinery/board/job new --what "OBSERVABLE OUTCOME" --evidence "WHY IT IS REAL NOW" --done "COMMAND reports EXPECTED RESULT" --not "NAMED OUT-OF-SCOPE FILE OR SYSTEM" --area AREA --kind bug|feature|chore --size small|medium|large --judge agent="WHAT SETTLES IT" --alone "WHY NO OPEN JOB OWNS IT" -p 2
   ```

   Add `--steps design,benchmark,record` only for optional playbook stages the
   job genuinely needs. A speed claim selects benchmark automatically; a named
   document selects record. If the same change must land in another registered
   project, declare each target up front with `--lands <project>`.

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

   For work with two or more meaningful steps, publish the provider's live
   checklist immediately after the claim and keep it current while working.
   Beads remains the durable project record; the checklist is only the live
   session view. Skip it for a genuinely one-step change.

   One claim covers the job's run. Closing or landing a piece hands the next
   opened work item or lifecycle step to the same session; do not claim each
   later child by hand. Claims expire after five minutes without session
   activity, and abandoned claims are reclaimed automatically.

4. Run the work item's stated check, commit the result with every work-item ID
   in the commit subject, and land it from that same worktree:

   ```bash
   git commit -m "<work-id>: OUTCOME"
   machinery/board/land <card-id>
   ```

5. After the work lands, follow the step the board opens; do not invent it:

   - For `Checks:`, run `machinery/checks <checks-id>` from the worktree. It
     selects and runs the declared suites, binds their exact counts to the
     current Git tree, records the proof, and closes the step. Use `--all` when
     every declared suite is required and `--dry` to inspect what it would run.
     If those exact suites were already run against the unchanged current tree,
     record them without rerunning:

     ```bash
     machinery/checks <checks-id> --record npm-test=1799/0 --record cargo-test=557/0
     ```

     `--record` is an explicit trust-based route: it marks the counts as
     manually supplied, accepts only suite names the project declares, and
     preserves the stale-tree and nonzero-failure refusals.
   - After the completed change and checks are known, decide whether external
     review is worth its cost. Use it for large or cross-cutting changes and for
     security, authorization, concurrency, migration, or data-loss risk. Skip it
     for localized routine work, documentation, tests, and mechanical edits.
   - When warranted, run only `machinery/board/review <job-id>` exactly once
     before teardown; do not invoke a model, reviewer agent, or review skill
     directly. The command delegates to the personal `external-review` runner,
     which invokes the personal Claude agent named `reviewer`. That agent's
     definition selects Sonnet, constrains its tools and turns, and preloads the
     `external-review` skill. This personal wiring is installed by Atelier and
     is intentionally outside the project worktree.
   - Review is never launched automatically. PASS, NEEDS_WORK, timeout,
     cancellation, malformed output, missing personal wiring, and account limits
     all consume the job's one attempt. Fix any findings and land them; never
     invoke the reviewer again.
   - Without external review, continue directly to done or manager review. After
     the one attempt, do the same once its findings are answered.
   - For any later open child, use `bd list --parent <job-id> --all`, follow
     that child's acceptance criterion, and use the command named on the card.

   Stop only when `bd show <job-id>` says the job is closed or asks for manager
   judgment.

## Operating rules the gates enforce

- Run every `bd` or `machinery/board/...` command on its own shell line. Do not
  chain it behind another command: the provider hooks use that boundary to stamp
  the session identity consistently.
- Never create cards with `bd create`. Use `machinery/board/job new`; add work
  the current change will touch with `machinery/board/job under <job-id>`, and
  open a separate complete job for a different cause, system, or scope. A fault
  discovered during implementation must take one of those two routes before the
  turn ends.
- A goal is a container, not a claimable card. Work items are its children; a
  child with open children is also a container. Claim the ready leaf the board
  gives you.
- Every step closes on evidence appropriate to its kind: a code-producing work
  item needs a commit naming that card on the landing branch; checks need the
  current-tree suite proof; no-code steps need the command, count, source, or
  manager decision their acceptance criterion names. Tests passing by
  themselves do not land code or advance the board.
- Follow the lifecycle child the board opens after each close. For teardown,
  the `Land:` step is not complete until the job branch is merged, its worktree
  and branch are gone, and the merge slot is free. Inspect with
  `bd list --parent <job-id> --all`; do not close the goal early.
- Keep durable findings and handoff state on the card with
  `bd update <id> --append-notes="..."`. Do not create Markdown TODOs, private
  handoff files, or documentation plans as parallel work trackers.
- Continue autonomously until one of three conditions is true: the job is
  finished, a question requiring manager judgment is on the board, or a helper
  you launched is still running. A progress report is not a reason to stop.

The lifecycle gates are authoritative. Tests alone do not finish work, and a
direct status change never replaces commit, landing, or closure. External review
is a completion-time risk decision, not a mandatory step and not a retry loop.
