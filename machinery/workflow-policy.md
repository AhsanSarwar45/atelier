Atelier uses one shared Beads board. A worktree isolates code; it does not create another board.

- Create or claim the bead before changing code.
- Classify scope before implementation. Work with three or more independently
  verifiable outcomes, or work spanning multiple product/system areas, is an
  epic: create at least two child execution beads that name those outcomes.
  A single bead is for one atomic outcome, not a container for an evolving
  programme of work.
- Do not implement directly from an undecomposed epic. Its children are the
  durable progress record; keep their statuses current as each area starts,
  reaches review, and lands.
- Use exactly one code worktree per unit of ownership. A standalone bead uses
  `worktrees/<bead-id>`; an epic and every child share
  `worktrees/<epic-id>`. Never create a separate worktree for an epic child.
- Ticket creation and atomic claiming must remain possible before a worktree
  exists. A narrowly scoped, recorded recovery bypass may repair a malfunctioning
  gate, but cannot bypass review, merge, land, or close prerequisites.
- A guarded `git merge --ff-only <bead-or-epic-branch>` is allowed from the main
  checkout because landing cannot occur inside the source worktree.
- Tests do not complete a bead. Tested but uncommitted work stays `in_progress`.
- Commit with the bead ID and merge that commit into the declared main line before advancing to agent review or closing the code step.
- Complete the job's checks, review, and land steps in order before closing the job.
- Never use a direct `bd` status change to bypass commit, merge, review, or land prerequisites. A command being accepted is not permission to skip the lifecycle.

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
