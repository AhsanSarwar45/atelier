---
name: beads
description: Use Atelier's native Beads workflow commands for durable work tracking, checks, review and landing.
---

# Atelier and Beads

## Completion contract

Done means `board/land` put the work on the project's completed-work branch
(main here). Nothing else makes work Done; deployment, cleanup and presentation
are not part of it.

A card is Todo until claimed, then In Progress. Review and Manager Review come
before landing. Cancelled means the scope was withdrawn, not delivered; record
why.

An epic has no status of its own. It is derived from its required children:

- All landed: Done. Cancelled children are ignored; if all are cancelled, the
  epic is Cancelled.
- All remaining children in Review: Review. All awaiting the manager: Manager
  Review.
- None started: Todo. Anything else: In Progress.

An empty epic, a missing child or a cycle is never Done; repair the hierarchy.
Reopening a child reopens its ancestors.

## Start work

1. Find existing work with `bd ready`, `bd list` or `bd search`. Read its
   acceptance with `bd show ID`.
2. If nothing fits, create a job. Each `--do` adds one work item; without
   `--do`, one item repeats the job. `job under` adds items later.

   ```bash
   atelier tool board/job new --what 'OUTCOME' --done 'ACCEPTANCE' --area AREA --kind bug --do 'WORK|ACCEPTANCE'
   atelier tool board/job under JOB-ID --do 'WORK|ACCEPTANCE'
   ```

   Ticket-writing preferences are guidance, not gates. Any nonempty acceptance
   is enough. Do not add checking or teardown cards to fit a template.
3. Make one worktree for the whole job, then claim the child you work on. Do not
   claim the epic. An older standalone card is its own job.

   ```bash
   git -C . worktree add worktrees/JOB-ID -b JOB-ID
   cd worktrees/JOB-ID
   bd update JOB-ID.1 --claim
   ```

   If the branch already exists, leave out `-b`. Reuse this worktree for every
   card in the job.

Repository files change only in your claimed job's worktree. `bd` commands work
from anywhere.

Keep evidence on the card with `bd update ID --append-notes='...'`. Mark a card
blocked only for an outside cause you cannot remove. Set status blocked and note
the cause and the exact input or change needed to resume. A question in your
reply is not a blocker record. Otherwise keep working until the card lands.

## Verify, review, land

```bash
git commit -m 'CARD-ID: outcome'
atelier tool checks CARD-ID --all
atelier tool review CARD-ID --provider claude
atelier tool board/land CARD-ID
```

- The commit subject must start with the card ID: `CARD-ID: outcome` or
  `fix(CARD-ID): outcome`. A mention elsewhere does not count.
- `checks` is optional. `board/land` runs any missing checks itself.
- Review follows the project's `external_review` policy. With `always`,
  `board/land` requires it. With `agent_decides`, you choose. With `never`, the
  review tool refuses. Use the external-review skill for the review itself, and
  resolve its findings before landing.
- Checks and review apply to the exact committed tree. Any change to the tree
  makes them stale. A rebase that keeps the tree does not.
- If the project requires visual proof, capture it before landing. The lander
  does not check it for you.
- Only the manager records a manager decision, and it must exist before landing.
- `board/land` checks review and approval, rebases, fast-forwards main and
  closes every card the commits name. With no declared suite there is no check
  step. If interrupted, run it again. Never close a card by hand instead.

### Failing checks never block landing

`board/land` fails when a declared check fails. Nothing lands, and its output
says what to do next.

- If this work caused the failures, fix them, commit, and run `board/land` again.
- If this work did not cause them, land anyway and say why:
  `atelier tool board/land CARD-ID --checks-unrelated 'REASON'`. The reason is
  recorded on the card.

So a failing suite is never a reason to mark work blocked. Always run
`board/land` and read its output. Never predict what it will do.

## Ownership

Hooks stamp your session as the board actor. Act only on cards your session
owns; another card's assignee is not yours to act as.

If an account or session change stranded your claim, first confirm the old
session has stopped. Then run this inside the job worktree:
`atelier tool board/reclaim CARD-ID --from OLD-ACTOR --abandoned --reason 'why'`.
It keeps the work and claims it for this session. It refuses live leases and
changed owners. Never impersonate the old actor or take work that is still
active.

## Status, repair and cleanup

- `atelier tool board/status [ID]` shows the stored and the derived status.
- `atelier tool board/reconcile` previews repairs. `--apply` finishes
  interrupted landings and re-derives parents. `--legacy` audits old commit
  headers; read its evidence before applying.
- Old workflow-step cards (labelled `no-code` plus a `step:` label) are not
  deliverables. `board/land` refuses them. Reconcile marks them Done when the
  work they belong to lands; they are never marked Cancelled. `--retire-steps`
  is an alias for reconcile.
- After the job is Done, run `atelier tool board/cleanup JOB-ID` from another
  checkout. `--force` first archives untracked files in the common Git
  directory; ignored build output is deleted. Tracked changes always stop
  cleanup. Cleanup needs no extra commit and no reopened card.

## Live checklist

A checklist is a view of an epic. For a Beads epic, pass that epic's ID as the
single item in the provider checklist. Atelier reads every title and status from Beads.
Never copy children into another list or update their checklist statuses by hand.
For a standalone ticket, do not publish a checklist.

## Gates and bypass

The `atelier` binary enforces this lifecycle through provider hooks and a Git
hook on the protected branch. Do not run files under `machinery/`.

- If the board cannot be read, gated commands are refused. Retry when it is back.
- Hooks cannot resolve shell variables in paths. Use explicit paths.
- Scratch files outside the repository, `/dev/*` and descriptor redirects such
  as `2>&1` are not repository writes.

If a gate refuses a command wrongly, rerun only that command with a reason:
`ATELIER_BYPASS='specific incorrect refusal' COMMAND`. The bypass is logged and
keeps your actor. Then record it at once with
`bd update CARD-ID --append-notes='Hook friction: command; refusal; expected behavior; workaround'`.
This works after landing too and needs no new card. If you own the gate's
repair, also add the entry to the repository's hook-friction journal.

Never export a standing bypass, reassign the card to the Git user, or use a
bypass to fake completion. Declared suites run without it.

Hook changes take effect only after the installed `atelier` binary is upgraded.
Passing source tests do not prove the active hooks changed.
