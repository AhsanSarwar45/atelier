# Hook friction, second book

The same purpose as `docs/hook-friction.md` — refusals that cost time without
protecting anything, and rules a gate enforces that the beads skill never
states. Kept separately so two agents can write at once; whoever tunes the
hooks should read both.

Kept by the agent working `bw-t26l.20`, from 2026-09-03.

## 1. Confirmed fixed, by measurement rather than by reading the diff

The first book's §1 through §4 are all in effect now that the binary has been
reinstalled. Measured in this session, not assumed:

- **The null device.** `echo probe 2>/dev/null && echo ok` runs. Silencing a
  command is ordinary again (§1).
- **The port probe.** `(exec 3<>/dev/tcp/127.0.0.1/3521)` runs, which is the
  probe this project's own `CLAUDE.md` requires before starting a stack (§2).
- **The honest landing.** `bd merge-slot acquire` then `git merge --ff-only`
  from the landing checkout passes, four times in this session, each time a
  small slice. The workaround the first book documents — `read-tree` plus
  `update-ref` — is no longer needed and is now itself gated (§4).

Nothing here needs tuning. It is written down because "resolved" in a document
and "works on this machine" are different claims, and only the second one is
worth anything to the next agent.

## 2. A refusal names what it resolved, but never what it resolved against

**Attempted**, as a background command:

```
export … WORKBENCH_E2E_RUN="$PWD/tests/.e2e-run-…" ; \
  scripts/workbench-e2e.sh tests/e2e/chat-agents.spec.ts > tests/.e2e-run-….log
```

The identical command had just run in the foreground.

**Refused with** `Changes require an owned Beads work item in its isolated
worktree (resolved target: /home/ahsan/dev/beads-web)`.

**Why it cost a round trip.** The gate was right: a background command in this
harness starts in the main checkout rather than the session's working
directory, so `tests/…log` really did resolve into the owner's repository. But
the message names only the resolved path, and the resolved path is the one
thing that looks impossible — the command holds no absolute path at all, and
the same words were fine a moment earlier. The missing half of the sentence is
the working directory the relative path was resolved against, which is the
whole explanation.

**Should have happened.** Say both ends of the resolution:

```
Changes require an owned Beads work item in its isolated worktree
  (target `tests/x.log` resolved from cwd /home/ahsan/dev/beads-web
   → /home/ahsan/dev/beads-web/tests/x.log)
```

A relative target is the case where this matters, and it is cheap: the gate
already has both strings in hand at the moment it refuses.

**Cost.** One refused command and one detour to work out which of two
identical-looking commands was in the wrong place. Small, and it will happen to
every agent that backgrounds a build or a test run.

## 3. A brand-new card cannot be claimed, because claiming it is a change

**Attempted.** The documented start of any piece of work, exactly as the
session brief spells it:

```bash
git -C . worktree add worktrees/bw-s5op.1 -b bw-s5op.1
cd worktrees/bw-s5op.1
bd update bw-s5op.1 --claim
```

**Refused.** Both halves, in turn. From the main checkout:

```
Changes require an owned Beads work item in its isolated worktree
  (resolved target: /home/ahsan/dev/beads-web).
```

and then, from inside the worktree the bypass had to create:

```
Beads issue bw-s5op.1 must be claimed and in_progress before this worktree is
  changed. Resolved target: /home/ahsan/dev/beads-web/worktrees/bw-s5op.1.
```

**Why it does not serve the rule.** The rule is that repository changes need an
owned card in its own worktree. Neither refused command is a repository change
in that sense: `git worktree add` creates the very isolation the rule demands,
and `bd update --claim` is how a card becomes owned. The gate treats its own
two preconditions as violations of itself, so the state it requires can never
be reached from a clean start — the only cards claimable without a bypass are
ones already claimed. Every session that files new work meets this, and the
refusal text points at the worktree it just refused to let anyone earn.

**Should have happened.** Two carve-outs, both narrow enough to keep the rule
intact:

- `git worktree add <path> -b <ID>` under the repository's own worktree
  directory is the rule being obeyed, not broken. Let it through.
- `bd update <ID> --claim`, and only `--claim`, is the transition into
  ownership. It should pass whenever the card is currently unowned; every other
  `bd` write can stay gated exactly as it is.

**Cost.** Four refused commands, one read of `docs/hooks.md`, and two entries in
`hook-bypass.log` that record nothing anyone wanted to be warned about. The
worse cost is the lesson it teaches: the first thing a new session learns about
the gates is that the documented path does not work and the bypass does.

## How to add to this file

As in the first book: what was attempted, the refusal text, why the refusal did
not serve the rule it enforces, what should have happened, what it cost.
