---
name: beads
description: Use Atelier's native Beads workflow commands for durable work tracking, checks, review and landing.
---

# Atelier and Beads

## Completion contract

Done means landed on the completed-work branch through `board/land`; nothing
else makes a card Done. Cards go Todo → In Progress (claimed) → Review →
Manager Review → Done. Cancelled means the scope was withdrawn; record why. An
epic has no status of its own: Atelier derives it from its children
(`atelier tool board/status ID` shows it).

## Start work

1. Find existing work with `bd ready`, `bd list` or `bd search`, and read its
   acceptance with `bd show ID`. If nothing fits, create a job; each `--do`
   adds one work item, and `job under JOB-ID --do ...` adds more later:
   `atelier tool board/job new --what 'OUTCOME' --done 'ACCEPTANCE' --area AREA --kind bug --do 'WORK|ACCEPTANCE'`.
   Ticket-writing preferences are guidance, not gates.
2. Make one worktree per job, then claim the child you work on, never the
   epic. A standalone card is its own job.
   `git -C . worktree add worktrees/JOB-ID -b JOB-ID` (drop `-b` if the branch
   exists), then `cd worktrees/JOB-ID` and `bd update JOB-ID.1 --claim`.

Repository files change only in your claimed job's worktree. Keep evidence on
the card with `bd update ID --append-notes='...'`. Mark a card blocked only for
an outside cause you cannot remove, with the cause and what is needed to
resume. Otherwise keep working until it lands.

## Verify, review, land

Commit as `CARD-ID: outcome` (the ID before the first colon), optionally run
`atelier tool checks CARD-ID --all`, then review if needed and run
`atelier tool board/land CARD-ID`. It runs missing checks, checks review and
manager approval, rebases, fast-forwards the branch and closes every card the
commits name. If interrupted, run it again. Never close a card by hand.

- Review follows the project's `external_review` policy; `atelier tool review
  CARD-ID --provider claude` runs it (see the external-review skill). Resolve
  findings before landing.
- Checks and review apply to the exact committed tree; changing it makes them
  stale.
- Only the manager records a manager decision.

`board/land` fails when a declared check fails. If this work
caused the failures, fix them, commit, and land again. If not, land with
`atelier tool board/land CARD-ID --checks-unrelated 'REASON'`.
A failing suite is never a reason to mark work blocked.
Always run `board/land` and read its output. Never predict what it will do.

## Ownership and cleanup

Act only on cards you claimed. If a session change stranded your claim and the
old session has stopped, run `atelier tool board/reclaim CARD-ID --from
OLD-ACTOR --abandoned --reason 'why'` in the job worktree; never impersonate
the old actor. `atelier tool board/reconcile [--apply]` repairs interrupted
landings and parents. After the job is Done, run `atelier tool board/cleanup
JOB-ID` from another checkout.

## Live checklist

A checklist is a view of an epic. For a Beads epic, pass that epic's ID as the
single item in the provider checklist, and Atelier reads every title and status from Beads.
Never copy children into another list.
Never update their checklist statuses by hand. For a standalone ticket, do not publish a checklist.

## Gates and bypass

Hooks enforce this lifecycle; do not run files under `machinery/`. Hooks cannot
resolve shell variables in paths, so use explicit paths. If the board is
unreachable, retry. If a gate refuses a command wrongly, rerun only that
command as `ATELIER_BYPASS='specific incorrect refusal' COMMAND`, then record it
at once with `bd update CARD-ID --append-notes='Hook friction: ...'`. Never
export a standing bypass or use one to fake completion.
