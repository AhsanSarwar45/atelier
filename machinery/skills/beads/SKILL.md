---
name: beads
description: Use Atelier's native Beads workflow commands for durable work tracking, checks, review and landing.
---

# Atelier and Beads

Atelier's lifecycle is implemented by the `atelier` binary. Do not invoke files
under `machinery/`; installed copies do not contain interpreters or executable
scripts.

Before changing repository files, find an existing ready card with `bd ready`,
`bd list`, or `bd search`.

A worktree belongs to a job, not to a step. Cut one copy named for the epic and
reuse it for every child underneath — a long job leaves one checkout on disk
instead of dozens. Each checkout carries its own `node_modules` and test
results, so a per-step copy costs gigabytes a step and has run this machine out
of btrfs metadata.

```bash
git -C . worktree add worktrees/JOB-ID -b JOB-ID
cd worktrees/JOB-ID
bd update JOB-ID.1 --claim
```

For a standalone card with nothing underneath it, the job is the card and the
two IDs are the same. For a job with children, claim each child in turn in the
copy you already have; do not cut a second one.

Atelier 0.22.0's `workflow-gate` has not caught up with this rule. It resolves
one card from the copy's directory name and requires that exact card to be
claimed and in_progress. A job is an epic and stays `open` while its children
run, so in a job's copy both the child's claim and every write are refused:

```
Claim JOB-ID.1 from its own isolated worktree, not …/worktrees/JOB-ID.
Beads issue JOB-ID must be claimed and in_progress before this worktree is changed.
```

Until the gate accepts a claimed descendant of the job the directory names,
carry each refused command through the documented bypass and say why. The
bypass must prefix the gated command itself — `export ATELIER_BYPASS=…` earlier
in the line does not carry:

```bash
ATELIER_BYPASS='a worktree is per job; this child is claimed in its job copy' \
  bd update JOB-ID.2 --claim
```

That covers `Edit`, `Write` and every gated shell write in the copy, so set the
reason once in a shell variable and prefix it to each. Do not answer the
refusal by cutting a second worktree — that is the cost this rule exists to
avoid.

Remove the copy when the job closes; nothing else reclaims that disk.

```bash
cd /path/to/main/checkout
git worktree remove worktrees/JOB-ID
```

Create work with the native command:

```bash
atelier tool board/job new --what "OUTCOME" --done "ACCEPTANCE" --area AREA --kind bug|feature|chore --do "WORK ITEM|ACCEPTANCE"
atelier tool board/job under JOB-ID --do "WORK ITEM|ACCEPTANCE"
```

Ticket-writing preferences are guidance, not gates. Titles may begin with verbs;
concise evidence is valid; any nonempty acceptance criterion is valid; inline
items are valid at every size. Hard refusals are reserved for ownership, dirty
or conflicting Git state, merge serialization, manager-review ownership, and
truthful completion.

Commit each finished work item with its card ID in the subject and land it from
the same worktree. `board/land` rebases, takes the merge slot, fast-forwards the
landing branch and releases the slot; it is the landing protocol, and a raw
`git merge --ff-only` from the landing checkout is gated on the same invariants:

```bash
git commit -m "CARD-ID: outcome"
atelier tool board/land CARD-ID
```

For a checks card, run the project's declared suites and record current-tree
evidence with `atelier tool checks CHECKS-ID`; use `--all`, `--dry`, or
`--record SUITE=PASSED/FAILED` when appropriate. For external review, use the
provider-neutral external-review skill; the app never starts a Python reviewer.

Keep durable findings on the card with `bd update ID --append-notes="..."`.

## Live checklist

A checklist is a view of an epic, not a second task list maintained by the
agent. Show one only when the work has a Beads epic: pass that epic's ID as the
single item in the provider checklist. Atelier replaces it with the epic's
direct children and reads every title and status from Beads, so never copy the
children into the checklist or update their checklist statuses by hand. For a
standalone ticket or work with no epic, do not publish a checklist. The agent's
only ongoing responsibility is keeping track of the ticket it is working on.

## Rules the gates enforce

Hooks are the safeguard, not the first line of enforcement. Know these and you
will not meet them. `docs/hooks.md` has the detail.

**Where you may write** (`workflow-gate`). Repository changes need an owned card
and its isolated worktree. The boundary is wider than editing a file: a shell
redirect is judged on the file it writes (`>`, `>>`, `&>`, `&>>`, `>|`, and what
`tee` is given), and a git verb that writes is judged on the repository it
writes — plumbing included (`read-tree`, `update-ref`, `update-index`, `push`,
and the rest), so there is no walk-around worth looking for. It is narrower than
it looks, too: `/dev/null` and the other pseudo-devices under `/dev`, `/proc`
and `/sys` are not files, a path in no repository is not gated at all, and a
heredoc body, commit message or quoted string that merely names a path is data,
not a command. A refusal names the target as you wrote it and the directory it
was resolved against; read that closely for a backgrounded command, which starts
in the main checkout rather than your worktree.

**Starting a card** (`workflow-gate`). The opening above passes as written —
`git worktree add worktrees/<ID> -b <ID>`, `cd`, `bd update <ID> --claim` —
whether you run it as one line or three. Only that shape: a destination outside
the project's worktree directory, a branch that is not the card, or any other
command on the line that writes something, and the line is judged normally.
The gate reads `<ID>` off the directory name and insists the claimed card match
it, so a child claimed in its job's copy needs the bypass shown above; that is
a gate that has not caught up with the rule, not a rule to work around by
cutting another copy.

**Landing** (`board-merge-gate`). The command above is the protocol: it
rebases, takes the merge slot, fast-forwards the landing branch and releases the
slot. A raw merge into that branch is held to the same invariants — it must be
`--ff-only`, the merge slot must not be held by somebody else, and it may not
overwrite the landing checkout's own uncommitted changes. That last refusal
names the files, so commit or stash exactly those. `board/land` is safe
to run twice: if the commits already landed it says so and finishes the close.

**Status moves** (`board-status-gate`). A card in manager review is the
manager's to move. A card cannot be closed while there are uncommitted changes
to tracked files; untracked scratch never blocks a close.

**Ending a turn** (`board-gate`). Do not close work before its named commit has
landed, and do not close a parent with unfinished children.

**Ending a turn truthfully** (`completion-gate`, Claude sessions only). A reply
that hands the work to someone later — "future session", "future agent", "left
for later", "deferred to a later/next…", "in a later session", "next session
will/should", "a future pass will" — ends the turn. State the concrete blocker
and what input it needs instead.

## When a gate is wrong

Do not step around it silently. Run the one command with an explicit reason:

```bash
ATELIER_BYPASS='why this gate is wrong here' <command>
```

Every hook honours it, on Claude and on Codex alike; it prints the reason and
appends it to `hook-bypass.log`. Then add the refusal to `docs/hook-friction.md`
or `docs/hook-friction-2.md` — either book — so the gate itself can be fixed. `docs/hooks.md` lists the wider switches, for a
session or a whole tree.
