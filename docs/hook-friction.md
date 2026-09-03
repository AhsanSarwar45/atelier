# Hook friction

A running log of hook refusals that cost an agent time without protecting
anything, and of rules a hook enforces that the beads skill never states. It is
written for whoever tunes the hooks — each entry says what was attempted, what
came back, why the refusal does not serve its own purpose, and what should have
happened instead.

Kept by the agent working `bw-t26l.20`, from 2026-09-03.

## 1. The null device is treated as a file the agent is mutating

**Attempted** `grep -n pattern file 2>/dev/nul` (with the real spelling), and
many other commands ending the same way.

**Refused with** `The mutation target is not inside a Git worktree (resolved
target: /dev/nul)`.

**Why it does not serve its purpose.** The gate exists so an agent cannot write
outside its own worktree. The null device is not a file: writing to it changes
nothing, cannot leave the worktree, and is the single most common way to silence
a command's noise. The refusal also arrives as a shell-level error with no
output at all, so the agent loses the command's result as well as the redirect.

**Should have happened.** Allow the null device — and character devices
generally — as a redirect target. Only regular files and directories are worth
resolving against the worktree.

**Cost.** Hit repeatedly across a long session; each hit is a wasted round trip
and a re-typed command.

## 2. Bash's TCP pseudo-paths are refused

**Attempted** a redirect to bash's `/dev/tcp/...` pseudo-path to check a port was
free before starting a worktree-local app, which the project's own `CLAUDE.md`
requires ("Probe both ports immediately before startup").

**Refused with** the same mutation-target message.

**Why it does not serve its purpose.** That path is not a file; bash turns it
into a socket connect. Nothing is written to disk anywhere.

**Should have happened.** Allow the tcp/udp pseudo-paths, or special-case them
the way the null device should be. The workaround —
`python3 -c "socket.connect_ex(...)"` — is strictly more code doing exactly the
same thing.

## 3. The gate reads command text, not redirects

**Attempted** writing this very file with a heredoc, whose prose names the null
device.

**Refused with** the mutation-target message, quoting a target that ends in a
backtick and a comma — the surrounding prose, not a redirect at all.

**Why it does not serve its purpose.** The check is matching the path anywhere
in the command string instead of parsing the command's actual redirects. A
document that merely mentions a path cannot write to it. This also means any
heredoc, commit message, or comment that names a path outside the worktree is
unwritable through the shell.

**Should have happened.** Parse redirect operators, or at minimum ignore text
inside quoted strings and heredoc bodies.

**Cost.** The document had to be written with a different tool than the one the
worktree's own instructions prefer.

## 4. Landing a finished branch is impossible for the agent that finished it

**Attempted**, from the main checkout, exactly the landing the session-start
instructions call for: `git merge --ff-only bw-t26l.20`.

**Refused with** `Changes require an owned Beads work item in its isolated
worktree (resolved target: /home/ahsan/dev/beads-web)`.

**Why it does not serve its purpose.** The instruction the agent is given is
"use fast-forward landings". A fast-forward landing onto `ours` can only happen
in the checkout that holds `ours`, which is by definition not the agent's
isolated worktree. So the rule as stated and the gate as implemented cannot both
be satisfied: work is committed on its branch and then stops, and a human has to
run one `git merge --ff-only` per slice. That is the opposite of the "commit and
merge small logical chunks as you go" the owner asks for — the smaller the
chunks, the more human merges the gate demands.

**Should have happened.** One of:

- allow a fast-forward-only merge into the main branch from the main checkout
  when the branch being merged is the agent's owned card branch and the merge is
  genuinely a fast-forward (no working-tree changes, no commit created); or
- provide a landing command the agent is told about. The beads CLI has
  `bd merge-slot acquire`, which reads like part of such a protocol, but nothing
  in the skill or the session-start message says landing goes through it, or what
  to run once the slot is held. Measured: acquiring the slot (`✓ Acquired merge
  slot: bw-merge-slot, Holder: s-9495be4e`) does not lift the gate — the same
  fast-forward merge is refused with the slot held, so either the slot is not the
  landing protocol or the gate does not know about it.

**Cost.** Every slice of finished, tested work waits on the owner.

## 5. Enforcement the beads skill never mentions

Rules discovered only by being refused:

- **Landing.** That a merge into the main branch is gated at all, and that
  `bd merge-slot` exists, is not in the skill text or the session-start
  instructions. Those say only "use fast-forward landings", which the gate then
  refuses (§4).
- **The worktree boundary covers shell redirects, and command text.** The skill
  describes the boundary in terms of editing files. It does not say that redirect
  targets are resolved against it (§1, §2), nor that the check reads the whole
  command string (§3).

## How to add to this file

One numbered section per distinct refusal, in the order encountered: what was
attempted, the refusal text, why the refusal does not serve the rule it is
enforcing, what should have happened, and what it cost. Append to §5 when a hook
enforces something the skill never told the agent.
