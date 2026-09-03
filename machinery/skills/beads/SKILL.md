---
name: beads
description: Use Atelier's native Beads workflow commands for durable work tracking, checks, review and landing.
---

# Atelier and Beads

Atelier's lifecycle is implemented by the `atelier` binary. Do not invoke files
under `machinery/`; installed copies do not contain interpreters or executable
scripts.

Before changing repository files, find an existing ready card with `bd ready`,
`bd list`, or `bd search`. Claim the ready leaf in its isolated worktree.

```bash
git -C . worktree add worktrees/WORK-ID -b WORK-ID
cd worktrees/WORK-ID
bd update WORK-ID --claim
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
Never move a card out of manager review, close work before its named commit has
landed, or close a parent with unfinished children.

The worktree boundary is wider than editing a file: a shell redirect is judged
on the file it writes, and a git verb that writes is judged on the repository it
writes, plumbing included. It is narrower than it once was, too — `/dev/null`
and the other pseudo-devices are not files, a path in no repository is not
gated, and a heredoc or commit message that merely names a path is data, not a
command. `docs/hooks.md` lists every gate and what it enforces.

When a gate is wrong, do not work around it silently: run the one command with
`ATELIER_BYPASS='why' <command>`, which stands every hook down for that command
and writes the reason to `hook-bypass.log`. Then record the refusal in
`docs/hook-friction.md` so the gate can be fixed. `docs/hooks.md` has the wider
switches, for a session or a tree.
