# Agent Instructions

This project uses Beads (`bd`) as its single shared board. Run `bd prime` when workflow context is missing or stale.

## Required lifecycle

- Create or claim the bead before changing code.
- Make code changes only in the dedicated `worktrees/<bead-id>` checkout.
- A worktree is code isolation, not a separate board; every checkout uses the same Beads board.
- Tests do not complete a bead. Tested but uncommitted work stays `in_progress`.
- Commit with the bead ID, merge that commit into the main line, and only then advance to agent review or close the corresponding code step.
- Complete review and land steps in the job spine before closing the job.
- Never use `bd close` or a status update to bypass commit, merge, review, or land prerequisites. A permissive CLI result is not authorization.

Use non-interactive shell flags. Preserve unrelated changes. Do not push or sync unless the user explicitly asks or the active repository profile grants that authority.
