---
name: beads
description: Use when working in a repository that uses bd or Beads for durable project task tracking, issue dependencies, blocker management, multi-session handoff, or shared work memory. Trigger when the user asks to find ready work, claim or close tasks, create follow-up work, inspect blockers, recover project context, or choose between local planning and persistent project tracking.
---

# Atelier and Beads

## Completion contract

Done, finished, fixed and resolved mean the deliverable has landed in the
project's configured completed-work branch (main in this repository).
Required verification and review happen before landing. Installation, deployment,
worktree cleanup and presentation do not keep delivered work open.

A leaf is Todo until claimed, then In Progress. Review and Manager Review are
pre-landing states. A failed prerequisite leaves the work unlanded. Cancelled
means the scope was withdrawn, not delivered. Record the reason.

An epic is a recursive view of required descendants, never a second status to
maintain. All required descendants landed means Done. Cancelled descendants
are excluded; all cancelled means Cancelled. Partial completion or descendant
activity means In Progress. If all remaining work is in review, show Review;
if all remaining work awaits the manager, show Manager Review. Untouched work
is Todo. An empty epic cannot be Done. Missing children or cycles prevent Done
and require repairing the hierarchy. Reopening a child reopens its ancestors.

## Working on a card

Before changing repository files, find existing work with `bd ready`, `bd list`
or `bd search`, then inspect its acceptance with `bd show ID`.

One worktree belongs to the entire job. Reuse it for every descendant; for a
standalone card the job ID and card ID are the same. The epic does not need a
manual claim: claim the child being worked on.

```bash
git -C . worktree add worktrees/JOB-ID -b JOB-ID
cd worktrees/JOB-ID
bd update JOB-ID.1 --claim
```

If the branch already exists, use `git worktree add worktrees/JOB-ID JOB-ID`.
Keep evidence and concrete blockers on the card with `bd update ID
--append-notes='...'`. An external blocker needs status blocked, its cause and
the exact input or external change needed to resume. A question mark in a reply
is not a blocker record. Continue owned work until it lands or has that record.

Create scoped deliverables with native commands:

```bash
atelier tool board/job new --what 'OUTCOME' --done 'ACCEPTANCE' --area AREA --kind bug --do 'WORK|ACCEPTANCE'
atelier tool board/job under JOB-ID --do 'WORK|ACCEPTANCE'
```

Ticket-writing preferences are guidance, not gates. Nonempty
acceptance is sufficient. Do not invent checks or teardown tickets merely to
satisfy a workflow template; these are operations on the deliverable.

## Verify, review, land

Commit changes with the deliverable ID in the subject header, for example
`CARD-ID: outcome` or `fix(CARD-ID): outcome`. Incidental mentions do not count.
Run the project's declared suites and provide its required visual evidence.
Checks and review evidence apply to the exact committed Git tree. Changes
invalidate evidence; rebasing without changing the tree preserves it.

```bash
git commit -m 'CARD-ID: outcome'
atelier tool checks CARD-ID --all
atelier tool review CARD-ID --provider claude
atelier tool board/land CARD-ID
```

External review follows the project's policy; use the external-review skill
when an independent review is required. The native lander runs missing checks,
verifies required review and manager approval, rebases, acquires the merge slot,
and fast-forwards main. A durable landing record closes every named deliverable
and updates its ancestors. Retry the same command if interrupted. Never manually
close a deliverable instead of landing it. No-code labels do not fabricate a
landing. Review findings remain evidence on the work; resolve them before land.

The caller's board actor must own the work. Hooks preserve it across compound
commands and native tools. Another card's assignee is not permission to act as
that assignee. A manager decision is recorded by the manager, before landing.

`atelier tool board/status [ID]` shows stored and effective states.
`atelier tool board/reconcile` previews repairs; `--apply` recovers interrupted
landings and derives parents. `--legacy` audits explicit historical commit
headers; inspect its evidence before applying. Historical verification, review,
landing and housekeeping subtasks become Done when their required implementation
is delivered, together with the parent. Completed steps are never relabelled
Cancelled. Cancelled is reserved for withdrawn scope. `--retire-steps` remains
an alias for this reconciliation; it no longer blanket-cancels workflow records.

After the job is Done, run `atelier tool board/cleanup JOB-ID` from another
checkout. Cleanup removes only merged work; it requires no dummy commit.

## Live checklist

A checklist is a view of an epic. For a Beads epic, pass that epic's ID as the
single item in the provider checklist. Atelier reads every title and status from Beads.
Never copy children into another list or update their checklist statuses by hand.
For a standalone ticket, do not publish a checklist.

## Enforcement and broken gates

The `atelier` binary implements the lifecycle. Do not execute files under
`machinery/`. Provider hooks enforce ownership and transitions; Git's
reference-transaction hook enforces the actual protected ref update. Board
reads that cannot establish an invariant refuse the mutation with a reason.
Browser moves use the same completion and hierarchy rules.

Repository writes need the owned job worktree; tracker-only edits do not.
Scratch outside repositories, pseudo-devices and file descriptor duplication
are not repository writes. Unresolved shell variables must be reported as
unresolved, not interpreted as literal paths. Use an explicit path if needed.

If a gate is wrong, carry only the refused command through a reasoned bypass:
`ATELIER_BYPASS='specific incorrect refusal' COMMAND`. It is logged. Session actor stamping survives the bypass; do not manually
reassign the card to the Git user. Record the
actual refusal in `docs/hook-friction.md` or `docs/hook-friction-2.md`. Do not
export a standing bypass or use it to override truthful completion. Declared
suites run without an inherited bypass. An old installed binary needs an
explicit upgrade; source tests alone do not prove that the active hooks changed.
