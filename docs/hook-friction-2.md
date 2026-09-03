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

## How to add to this file

As in the first book: what was attempted, the refusal text, why the refusal did
not serve the rule it enforces, what should have happened, what it cost.
