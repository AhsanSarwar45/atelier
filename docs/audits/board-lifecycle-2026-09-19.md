# Board lifecycle repair — 19 September 2026

## Why the board disagreed with the work

1. The detail panel, board columns, counts and workflow commands calculated state
   separately. A stored epic status and a shallow child calculation could disagree.
2. Completion depended on an agent manually closing a card after Git changed.
   Interrupted landing left no reliable way to finish the board transaction.
   Generated checks, review and cleanup tickets kept delivered parents open.
3. Provider adapters did not preserve the same command fields, working directories,
   patch paths or session identities. Codex lacked equivalent stop wiring. The Git
   reference hook received raw ref records but its dispatcher expected JSON.
4. Instructions mixed per-child and per-job worktrees, post-land signoff and
   pre-land verification, prose preferences and hard gates. Installed binaries
   could continue enforcing old rules after source changed.
5. Historical blanket closes, migrated parent labels and incorrectly typed epics
   made the existing records unreliable even after fixing the code.

## Implemented contract

[The lifecycle contract](../board-lifecycle.md) is the canonical instruction source.
Done, fixed, finished and resolved mean the deliverable reached main. Required
checks, external review and manager approval precede landing. Deployment and
cleanup do not affect completion. A manager approves an exact reviewed tree;
that action does not close unlanded work.

One recursive Rust projection drives board state. Required descendants all done
means the epic is done; partial completion means in progress. Review requires all
remaining descendants in review, and manager review requires all remaining work
awaiting the manager. Cancellation is withdrawn scope. Empty epics, missing links
and cycles cannot falsely complete. Reopening required work reopens ancestors.

The native lander records a durable Git transaction, closes the named delivered
cards and reconciles their parents. Recovery preserves cancellations and does not
re-close reopened work from old receipts. UI writes, provider hooks and the real
Git ref hook enforce the completion boundary. Full snapshot refreshes and serialized
cache invalidation keep the screen current.

## Historical repair performed

The operational cancellation treatment below was corrected by the
[follow-up completion audit](board-operational-completion-2026-09-19.md).
Delivered workflow records are Done, not Cancelled.

- 33 deliverables closed with main-branch evidence, including audited corrections
  for legacy work incorrectly typed as empty epics.
- 54 obsolete policy or generated operational records cancelled, preserving history.
- 3 incorrectly closed bugs reopened: bw-sw4l, bw-1cqk and bw-2i0j.
- 1 migrated external-parent label repaired: mch-qrnj.51. Its external reference
  remains recorded and its landing commit was verified.
- Parent states reconciled, including 11 further changes in the explicit migration
  after the initial landing reconciliation.
- 4,560 records checked: zero stored/derived state disagreements and zero hierarchy
  errors. A second historical reconciliation proposed zero mutations.

Unproven retained tickets were not declared finished. The audit records those
individually; a lack of evidence is not proof that a feature was delivered.
Other active sessions can change the board after this snapshot.

[Machine-readable decisions and evidence](board-lifecycle-2026-09-19.json) record
every manual repair, native reconciliation decision and retained record. Updates
checked their prior status; manual repairs also checked the previous timestamp.

## Verification

- Staged executable reports workflow protocol 3; actual Claude and Codex tool
  envelopes preserve the full actor identity and working directory, and allow read filters.
- Full declared frontend and Rust suites passed before landing the lifecycle changes.
- Actual Git/Beads integration exercised standalone and nested landing, failed checks,
  required review, dependencies, incidental commit mentions, interruption recovery,
  cancelled scope, reopened receipts and cleanup without dummy commits.
- The isolated packaged app passed a real Chromium run covering board/detail agreement,
  child reopening, forced-close rejection and exact-tree manager approval.
- Screenshots: tests/results/landing-state/{before,after,detail-after,approval-after}.png.
- Independent review returned four findings. All were addressed, with regressions:
  read filters mistaken for writes, cancelled recovery journals, ungated cancellation,
  and an unbounded stop loop during board outages. The review was not recorded as PASS.

## Runtime boundary

The owner's running app, data and processes were not replaced or restarted, as
required by AGENTS.md. Verification used disposable worktree-local app instances
and the built executable, including the installed-format Git hook. Source landing
is completion; activating this version in the owner's running installation is a
separate deployment. Existing sessions still carrying older injected instructions
or an older installed binary do not acquire the new implementation by magic.
