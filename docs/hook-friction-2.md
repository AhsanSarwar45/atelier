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

**Resolved.** A refusal carries the target it judged rather than only the path
it arrived at. A relative one now reads:

```
Changes require an owned Beads work item in its isolated worktree
  (target `tests/.e2e-run-x.log` resolved from /home/ahsan/dev/beads-web
   → /home/ahsan/dev/beads-web/tests/.e2e-run-x.log)
```

An absolute target resolved to itself, so it still says `resolved target: …`
and nothing more. Paths are tidied lexically on the way out, so a target
reached through `..` names where it landed instead of how it got there.
`native_machinery_a_refusal_says_both_ends_of_the_resolution`,
`native_machinery_tidies_a_path_without_asking_the_disk`.

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

**Resolved**, as both carve-outs, and narrowly.

- `git worktree add worktrees/<ID> -b <ID>` passes. The destination must sit in
  the project's own worktree directory (`worktrees/<ID>` or
  `.worktrees/bd-<ID>`), be named for the card, belong to the same project —
  compared by the checkout every worktree shares, not by `--show-toplevel`,
  which answers with the worktree it was asked from — and the branch created
  must be that same card. `worktree remove`, a destination elsewhere, a
  mismatched branch and a bare `add` all stay gated.
- `bd update <ID> --claim` passes whenever the card is unowned, as it already
  did; what did not pass was the documented *line*. The claim carve-out
  required the line to hold nothing but the claim, and the documented opening
  holds three commands. It now asks the weaker and truer question: does
  anything else on this line change something? Making the worktree and stepping
  into it do not, so the block passes verbatim; `rm file && bd update ID
  --claim` still does not.
- The gate runs before the line does, so the worktree the claim wants to be
  judged in does not exist yet. A claim into the worktree the same line creates
  is judged against that destination.

`native_machinery_lets_a_session_earn_the_worktree_the_rule_demands`,
`native_machinery_reads_the_claim_a_whole_opening_line_makes`.

## 4. The lander cannot close what it just landed, and then blames the commit

**Attempted.** The documented last step of a card, from the card's own
worktree, with the card claimed by this session:

```
atelier tool board/land bw-s5op.3
```

**Refused with.**

```
bd --actor failed: cannot close bw-s5op.3: assignee is "s-d952fe9b",
actor is "atelier-land"; reclaim or use --force to override
```

**Why it does not serve the rule.** The rule behind the assignee check is that
one agent should not close another agent's work. But `atelier-land` is not
another agent — it is the lander this session invoked, on this session's card,
one command after this session committed to it. The check reads the ownership
the workflow spent four commands establishing and calls it a conflict. There is
no way to satisfy it from inside the workflow either: bd refuses to reassign a
card while it is `in_progress`, so the card cannot be handed to the lander that
requires it to be handed over.

The second cost lands on the retry. The rebase and the fast-forward run
*before* the close, and they succeed — `ours` already had the commit. So the
second `board/land` looks at an empty range and reports:

```
no commit subject on bw-s5op.3 names bw-s5op.3
```

which describes the opposite of what happened. A reader following the message
goes looking for a badly-named commit that does not exist, when the truth is
the commit was named correctly and landed the first time. This cost the same
detour on bw-s5op.1 and bw-s5op.2 before it was recognised here.

**Should have happened.** Two fixes, independent of each other:

- The lander should treat the invoking session's own assignee as its own —
  `--actor atelier-land` acting on a card assigned to the session that called
  it is the normal case, not a conflict. Failing that, the lander should
  reassign the card itself as its first step, since it is the one command that
  knows both the session and the actor.
- When the range is empty because the commit already landed, say that. "The
  commit is already an ancestor of `ours`; nothing to land" is true, and it
  tells the reader the work is safe. The current message asserts a naming
  failure it has not checked for.

**Cost.** Three cards, each ending in the same detour: a failed land, a retry
with a misleading error, `git merge-base --is-ancestor` run by hand to find out
whether the work was actually safe, and a manual `bd close`. The documented
finishing move has never once finished a card in this epic.

**Resolved**, as both fixes.

- The lander acts as the card's own assignee, so a session closing work it owns
  is the ordinary case it looks like. `BEADS_ACTOR` still overrides, and an
  unassigned card still falls back to `atelier-land`. The rule the assignee
  check exists for is untouched: work owned by another session still refuses.
- The retry tells the truth. When the range is empty because the branch is
  already an ancestor of the landing branch, the lander says so — `had already
  landed on ours, so there was nothing to merge` — skips the rebase, the slot
  and the merge, and goes on to close the work items the landed commits named.
  A second `board/land` now finishes the card instead of describing a naming
  failure that did not happen.

`native_machinery_the_lander_acts_as_the_card_it_was_given`,
`native_machinery_a_land_knows_its_work_is_already_on_the_branch`.

## 5. A card whose id has no digit can never be landed

**Attempted.** The documented last step of a card, from its own worktree, on a
branch whose one commit is named for it:

```
git log --oneline ours..bw-uxoe
29f9a78 fix(bw-uxoe): the chat list, opening a chat and starting one answer at once again
atelier tool board/land bw-uxoe
```

**Refused with.**

```
no commit subject on bw-uxoe names bw-uxoe
```

**Why it does not serve the rule.** The rule is that a landing commit must name
its card. The subject does. The lander reads card ids out of a subject with
`card_ids` in `server/src/board_tools.rs`, which keeps a word only if it holds
a hyphen *and a digit*. `bw-uxoe` is an id `bd create` handed out; it has no
digit, so it is invisible to the check, and no subject in any form — `bw-uxoe:`,
`fix(bw-uxoe):`, the bare id — can satisfy it. The message then reports the
opposite of what happened, as entry 4 already noted for the empty-range case.

**Should have happened.** Either the check asks whether the subject contains
the id it was given (a substring test needs no guess about what an id looks
like), or the shape it does guess matches what `bd` actually issues. The
truthful message on a miss would quote the subjects it read.

**Cost.** Two lands refused, a read of the lander's source to learn why, and
the card landed by hand with the fast-forward merge the gate allows.

**Worked around.** `git merge --ff-only bw-uxoe` from the `ours` checkout, then
`bd close`.

## 6. A checks card cannot close while a suite unrelated to it is red

**Attempted.** `bd close bw-oion.2`, the checks step of a card whose whole
change is one SQL query in `server/src/workbench/store.rs`. The declared suite
is `npm test && (cd server && cargo test)`, and `atelier tool checks` had just
recorded it against the current tree.

**Refused with.**

```
bw-oion.2 is the checks step and has no fresh passing evidence for the current Git tree
```

**Why it does not serve the rule.** The rule is that a checks card may not
claim evidence it does not have. It has evidence: the suite ran on this tree
and the result is recorded. What it does not have is a *green* suite, because
two failures live on `ours` and predate the card — `check-agent-workflow.test.ts`
counts three copies of a managed command where it expects two, and
`a_first_start_wires_the_chats_up` never hears its announcement. Both were
proved independent of the change by replacing this card's `store.rs` with the
parent commit's and watching them fail unchanged. The server library suite is
677 green. So the gate holds every checks card on the board hostage to two
failures no card introduced, and the only ways past it are to fix work nobody
asked for or to record a result that is not true.

**Should have happened.** The refusal should name the suites that failed and
say whether any of them touched what this card changed; and there should be a
way to record a red suite as *known red, filed as CARD* so the evidence stays
truthful and the card can still close. The gate would then refuse only a card
whose own change broke something.

**Cost.** A full second run of both suites to see the failures on their own, a
third run of the cargo test with the parent commit's file to prove it was not
this change, and two cards opened for failures outside this work.

**Worked around.** `ATELIER_BYPASS` with the reason, after recording the two
failures and their new cards on bw-oion.2.

## How to add to this file

As in the first book: what was attempted, the refusal text, why the refusal did
not serve the rule it enforces, what should have happened, what it cost.
