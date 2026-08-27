---
name: beads
description: Use Atelier's enforced Beads board lifecycle in a project registered for Beads, including worktrees, checks, review, and landing.
---


# Atelier workflow

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

   For work with two or more meaningful steps, publish the provider's live
   checklist immediately after the claim and keep it current while working.
   Beads remains the durable project record; the checklist is only the live
   session view. Skip it for a genuinely one-step change.

4. Run the work item's stated check, commit the result with every work-item ID
   in the commit subject, and land it from that same worktree:

   ```bash
   git commit -m "<work-id>: OUTCOME"
   machinery/board/land <card-id>
   ```

5. After the work lands, follow the step the board opens; do not invent it:

   - For `Checks:`, run `machinery/checks <checks-id>` from the worktree. It
     runs the declared suites, records their exact result, and closes the step.
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

The lifecycle gates are authoritative. Tests alone do not finish work, and a
direct status change never replaces commit, landing, or closure. External review
is a completion-time risk decision, not a mandatory step and not a retry loop.
