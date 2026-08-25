# Agent Instructions

This project uses Beads for durable task tracking. Run `bd prime` before work.

<!-- BEGIN ATELIER WORKFLOW -->

## Atelier workflow (managed)

Atelier uses one shared Beads board. A worktree isolates code; it does not create another board.

- Create or claim the bead before changing code.
- Classify scope before implementation. Work with three or more independently verifiable outcomes, or work spanning multiple product/system areas, is an epic: create at least two child execution beads that name those outcomes.
- Do not implement directly from an undecomposed epic. Its children are the durable progress record; keep their statuses current as each area starts, reaches review, and lands.
- Make code changes only in the dedicated `worktrees/<bead-id>` checkout.
- Tests do not complete a bead. Tested but uncommitted work stays `in_progress`.
- Commit with the bead ID and merge that commit into the declared main line before advancing to agent review or closing the code step.
- Complete the job's checks, review, and land steps in order before closing the job.
- Never use a direct `bd` status change to bypass commit, merge, review, or land prerequisites. A command being accepted is not permission to skip the lifecycle.

<!-- END ATELIER WORKFLOW -->
