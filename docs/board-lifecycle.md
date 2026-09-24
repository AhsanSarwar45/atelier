# Atelier and Beads

## Completion contract

Done means landed on the project's completed-work branch (main here). A card
becomes Done only through `board/land`. Installation, deployment, cleanup and
presentation are not part of Done.

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
   `--do`, the job gets one item with the same what and done. `job under` adds
   items later.

   ```bash
   atelier tool board/job new --what 'OUTCOME' --done 'ACCEPTANCE' --area AREA --kind bug --do 'WORK|ACCEPTANCE'
   atelier tool board/job under JOB-ID --do 'WORK|ACCEPTANCE'
   ```

   Ticket-writing preferences are guidance, not gates. Any nonempty acceptance
   is enough. Do not add checking or teardown cards to fit a template.
3. Make one worktree for the whole job, then claim the child you work on. Do not
   claim the epic. For an older standalone card, its ID is the job ID; claim
   that card itself.

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

- The card ID must appear in the commit subject before the first colon:
  `CARD-ID: outcome` or `fix(CARD-ID): outcome`. A mention after the colon or
  in the body does not count.
- `checks` is optional. `board/land` runs any missing checks itself.
- Review follows the project's `external_review` policy. With `always`,
  `board/land` requires it. With `agent_decides`, it is your call unless the
  card or a parent requires it (it is in Review, or was created with review
  steps); then `board/land` requires it too. With `never`, the review tool
  refuses. Run `atelier tool review`; the external-review skill describes how.
  Resolve findings before landing.
- Checks and review apply to the exact committed tree. Any change to the tree
  makes them stale. A rebase that keeps the tree does not.
- Capture visual proof for interface changes (see the Atelier instructions)
  before landing. The lander does not check it for you.
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

Hooks stamp your session as the board actor. Act only on cards you have
claimed; another card's assignee is not yours to act as.

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
  work they belong to lands; they are never marked Cancelled. The
  `--retire-steps` flag is accepted and does the same as plain reconcile.
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
repair, also add the entry to a hook-friction journal in that job's worktree.
Never edit the main checkout after landing just to log it.

Never export a standing bypass, reassign the card to the Git user, or use a
bypass to fake completion. Declared suites run without it.

Hook changes take effect only after the installed `atelier` binary is upgraded.
Passing source tests do not prove the active hooks changed.

## Contradictions repaired by bw-9vv9

| Previous behavior | Required behavior | Enforcement |
| --- | --- | --- |
| Detail reads stored status; columns recalculate shallow children | One recursive server projection | board_state and full snapshots |
| All children closed advances epic to review | All required work landed means Done | board_landing parent reconciliation |
| Checks/review generated after work closes | Exact-tree prerequisites before merge | native lander |
| Cleanup requires its own commit | Cleanup is a separate operation | board/cleanup |
| Standalone and historical commit mentions mishandled | Explicit headers and durable receipt | landing journal |
| Browser force-closes unfinished scope | Same completion invariant for every writer | transition |
| Raw Git hook parsed as JSON | Validate raw reference transactions | landing-gate |
| Codex cmd/workdir/patch targets discarded | Preserve tool envelope and all paths | lifecycle normalization |
| Only first card in multi-close checked | Check every operand | status gate |
| Question marks or board outages waive completion | Persist blockers; report unavailable evidence | board gate |
| Eight-character actor collisions | Full stable session identity | board actor |
| Copied provider settings drift | Generated and checked-in hooks tested together | join tests |

Historical friction entries describe the behavior at their recorded date. They
are evidence, not exceptions to this contract. This contract supersedes older
acceptance that permits forced Done without landing or requires post-land review.

## Abandoned sessions and post-land operations

Use `board/reclaim CARD-ID --from OLD-ACTOR --abandoned --reason TEXT` inside
the job copy only after confirming the previous session stopped. It changes
ownership with a compare-and-set guard and preserves the work; live leases,
manager review and settled work cannot be recovered this way.

Cleanup of a merged, completed job can use `board/cleanup JOB-ID --force` to
archive non-ignored untracked files before removing its worktree; ignored build
scratch is removed. Tracked changes are never
silently discarded. Report post-land friction with `bd update CARD-ID
--append-notes='Hook friction: ...'`; copying it into a repository journal belongs
to the owned repair, not an unowned write or a new procedural card after landing.
