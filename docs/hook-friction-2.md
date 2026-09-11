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

## 7. The evidence a green run records is not the evidence the gate reads

**Attempted.** `bd close bw-hgd2.2`, the checks step of a card whose change is
the chat list's day headings. `atelier tool checks bw-hgd2.2` had just run the
project's whole declared suite on that tree and printed
`checks: tree a5f9b4a5… Project checks=719/0` — 719 green, nothing red — and
written that same line onto the card. The tool then tried to close the card
itself and could not, so the close was tried by hand.

**Refused with.**

```
bw-hgd2.2 is the checks step and has no fresh passing evidence for the current Git tree.
```

**Why it does not serve the rule.** The rule is that a checks card may not
claim evidence it does not have. It has it, on the card, for that tree, from a
run of the declared suite finished a minute earlier. The two halves simply did
not speak the same language. `atelier tool checks` files the run under
`git write-tree` and writes counts — `Project checks=719/0`; `fresh_checks`
looked the evidence up under `git rev-parse HEAD` and wanted the word
`=PASSED`. Neither the hash nor the token could ever match, so no checks card
could be closed at all: the last one to close on this board did so on 30 August,
before the rule arrived. Entry 6 above hit the same refusal from the other side
and read it as a rule about red suites; it is not, and a green suite fares no
better.

**And the fix cannot let the card that carries it through.** The gates run
`atelier` from the path, which is the copy the reader installed — the one in
`/home/linuxbrew/.linuxbrew/bin`, not the one built from the tree the change is
in. A repository whose own gates are enforced by a release of themselves cannot
mend a gate and land the mending in one turn: the refusal outlives the commit
that fixes it until somebody reinstalls.

**Should have happened.** The two halves should be held to each other by a test
that runs both — now `what_a_run_records_is_what_this_gate_accepts` in
`lifecycle.rs`, which builds the line the way a run builds it and hands it to
the gate. And a gate whose fix has landed but is not yet installed should say
so, rather than repeating a refusal the tree no longer earns.

**Cost.** Two cards opened for suites red before this work began
(`check-agent-workflow.test.ts` and `a_first_start_wires_the_chats_up`, both
proved independent of the change and both fixed), a third card for the mismatch
itself, four full runs of a suite that takes both a `cargo build` and a
`next build`, and a bypass on every checks card on the board until the reader's
copy is replaced.

**Worked around.** `ATELIER_BYPASS` with the reason, on a card whose green run
is recorded on the card itself.

## 8. A land card cannot finish, because finishing means removing the floor it stands on

**Attempted.** `bw-d516.6` and `bw-gao7.3`, the land steps of two finished
jobs. Their acceptance is one sentence — "The branch and worktree are gone and
the merge slot is free" — and every branch under both jobs was already an
ancestor of `ours`. The removals were run from the land card's own worktree,
which is where the workflow gate says repository changes belong.

**Refused with.** Three times, on three different lines of the same tidying.

```
Changes require an owned Beads work item in its isolated worktree (resolved target: /home/ahsan/dev/beads-web).
```

for `git worktree remove worktrees/bw-d516.1` run from the main checkout — the
natural place, because the paths are the main checkout's. Removing a worktree
writes to the shared admin directory, so the target resolves there whatever the
cwd; `../bw-d516.1` from inside the land worktree passes, and the same removal
of the same directory is refused when spelled from above it.

```
cannot close bw-gao7.3: assignee is "s-31a18b5b", actor is "AhsanSarwar45"; reclaim or use --force to override
```

after the land card removed its own worktree. The actor is read from the
environment the worktree carries; delete the worktree and the same session
becomes a different person to the board, holding a claim it can no longer act
on.

```
Changes require an owned Beads work item in its isolated worktree (resolved target: /home/ahsan/dev/beads-web).
```

again, for the `bd close` that would have ended it — there was by then no owned
worktree anywhere to close it from, because closing it required removing the
last one.

**Why it does not serve the rule.** The rule is that repository changes are
made from the worktree of the card that owns them. A land card owns exactly
this change, and it did make it from there. What the gate cannot express is
that the last removal is reflexive: the card's acceptance is the absence of its
own workspace, so the state in which it is allowed to act and the state its
acceptance describes cannot both hold. Every land card on this board meets it,
which is why finished worktrees pile up — twenty-three of them stood in
`worktrees/` when this was written, most belonging to jobs long closed.

**Should have happened.** The land step should be able to say what it is: the
tool that removes a job's workspaces, itself included. Either `board/land` (or
a `board/tidy` beside it) should do the last removal from outside on the card's
behalf, so no session has to stand where it is deleting; or the gate should
recognise a card labelled `step:land` acting on its own job's worktrees and let
it through from the main checkout, which is the only place the whole set is
addressable. The actor should also outlive the worktree — a claim that becomes
unusable the moment its workspace goes is a claim that cannot be released
truthfully.

**Cost.** Two jobs' land steps, three bypasses, and a close that had to be
written as `ATELIER_BYPASS=... BEADS_ACTOR=... bd close` to say a true thing.
Filed as bw-xksa.

**Worked around.** `ATELIER_BYPASS` with the reason on each of the three, and
`BEADS_ACTOR` restored by hand for the close. The reason given each time was
that a worktree cannot remove itself.

**Met again**, unchanged, on `bw-qrgl.3` — a third job's land step. The same
`git worktree remove` refusal from the main checkout, then the same one for the
`git branch -d` that follows it, which is not a worktree operation at all: a
branch already merged into `ours` has no working tree left to be isolated in,
and the landing checkout is the only place its name is addressable. Then the
actor half of it, from the other side: this land card was claimed from the
landing checkout, where the session actor is not carried, so the board recorded
the claim under the git user and afterwards refused this session every verb on
its own card — including the `bd show` that would have told it why. Four more
bypasses on the one reason, which is the shape section 8 describes and bw-xksa
still holds.

## 9. A path the shell would have expanded is resolved against the repository

**Attempted.** Deleting one scratch directory in Atelier's own data dir, from a
session whose shell stood in the main checkout:

```bash
rm -rf ~/.local/share/atelier/projects/0739b8c7…
rm -rf "$HOME/.local/share/atelier/projects/0739b8c7…"
```

**Refusal.** Both times, and the second names the problem exactly:

```
Changes require an owned Beads work item in its isolated worktree
(target `$HOME/.local/share/atelier/projects/0739b8c7…` resolved from
/home/ahsan/dev/beads-web → /home/ahsan/dev/beads-web/$HOME/.local/share/…)
```

**Why it did not serve the rule.** The rule is that repository files need an
owned card in its worktree, and a path in no repository is not gated at all.
The target was in no repository — it is Atelier's data dir under the home
directory. The gate reads the command as written, before the shell expands it,
so `~` and `$HOME` are neither absolute nor relative but literal; it joins the
literal to the working directory and gets a path that exists nowhere, then
gates the session on it. The refusal is not about the file being protected. It
is about the gate not knowing where the file is.

**Should have happened.** A leading `~/` or `$HOME/` should expand before the
target is resolved — those two are not ambiguous, and every other shell in the
session expands them. Failing that, a target that resolves to a path which does
not exist and lies in no repository should not be refused as a repository
change; the refusal should say the gate could not locate the target, which is
the true thing.

**Cost.** Two refusals and a third command, on a delete that was undoing this
session's own test litter. The literal absolute path went through first time.

**Worked around.** Wrote the path out in full: `/home/ahsan/.local/share/…`.

## How to add to this file

As in the first book: what was attempted, the refusal text, why the refusal did
not serve the rule it enforces, what should have happened, what it cost.

## 10. The checks tool still has the actor bug the lander had fixed

**Attempted.** The documented last step of a checks card, from its own
worktree, with the card claimed by this session:

```
atelier tool checks bw-cdav.4 --all
```

**Refused with**, after every suite had run and passed:

```
checks: tree 934bedb… Project checks=PASSED (767 passed, 0 failed)
bd close failed: cannot close bw-cdav.4: assignee is "s-817c0fab",
actor is "AhsanSarwar45"; reclaim or use --force to override
```

**Why it does not serve the rule.** This is §4 above, in a second tool. The
assignee check exists so one agent does not close another agent's work, and
here there is only one agent: `s-817c0fab` is this session's board actor, named
as such in its own start-up brief, and `AhsanSarwar45` is the human whose git
identity the same session commits under. The card was claimed by this session
four commands earlier. §4's fix taught `board/land` to act as the card's own
assignee; `atelier tool checks` closes through a different path and never
learnt it.

The cost is worse here than in a land, because the refusal arrives *after* the
expensive part. Every suite had been run — vitest, the Rust tests, the build —
and the comment recording the tree and the result had already been written. The
only thing left was a status flip, and it is the only thing that failed, so the
card sits in progress with its own evidence attached saying it passed.

**Should have happened.** The same fix as §4, in the same place: whatever
resolves the actor for a `bd close` issued by an Atelier tool should treat the
invoking session's assignee as its own. Failing that, `atelier tool checks`
should reclaim the card before closing it, exactly as it already claims the
right to append the checks comment to it.

**Cost.** One full re-run of the project's checks — several minutes of Rust
compilation and 767 tests — was not itself wasted, but the manual
`bd update --claim && bd close` that followed it is two commands the documented
workflow says nothing about, and an agent that stopped reading at
`checks=PASSED` would leave the card open.

## 11. A finished epic's status move has nowhere it is allowed to be made from

**Attempted.** The handoff at the end of an epic: every child closed, every
commit landed, the parent moved to the manager's queue.

```
bd update bw-cdav --status manager_review
```

**Refused**, from all three directories there are:

```
Beads issue bw-cdav.4 must be claimed and in_progress before this worktree is
  changed. The resolved target: /home/ahsan/dev/beads-web/worktrees/bw-cdav.4.
Beads issue bw-cdav.1 must be claimed and in_progress before this worktree is
  changed. The resolved target: /home/ahsan/dev/beads-web/worktrees/bw-cdav.1.
Changes require an owned Beads work item in its isolated worktree
  (resolved target: /home/ahsan/dev/beads-web).
```

**Why it does not serve the rule.** The rule is that repository changes need an
owned card in its own worktree. A `bd update --status` is not a repository
change — it writes the Beads database, and the files in every one of those
three directories are untouched by it. The gate judges it by where it was run
from, and by the end of an epic there is no directory left that satisfies the
test: each child's worktree fails because that child is now closed rather than
in progress, and the main checkout fails because it is not a worktree at all.
The state the gate demands is one the successful completion of the work has
just destroyed.

It is §3's shape at the other end of the card's life. §3 was the first thing a
session cannot do because it has not started yet; this is the last thing it
cannot do because it has finished. Both are the gate refusing the workflow's own
punctuation.

**Should have happened.** A `bd` status verb on a card the actor is entitled to
move should not be judged as a write to whatever directory it was typed in. The
narrow form, matching §3's claim carve-out: `bd update <ID> --status …` passes
when the line changes nothing else, leaving every `bd` write that does touch
files gated exactly as it is. The wider and truer form is that `bd` writes to
its own database and only the commands that reach tracked files belong to this
gate at all.

**Cost.** Three refusals, one `ATELIER_BYPASS` recording a reason nobody needed
warning about, and — because writing this section is itself a repository change
— a card and a worktree raised for the sole purpose of being allowed to describe
the refusal.

## 12. A closed card's worktree cannot throw away its own ignored scratch

**What happened.** bw-cwap.1's e2e runs left three git-ignored scratch
directories under `tests/.e2e-run-bw-cwap.1*` in its worktree. After the card
closed, `rm -rf` of those directories from inside that worktree was refused by
`workflow-gate`: the worktree's card is no longer owned, so any write there is
a write without a card.

**Should have happened.** Deleting something git ignores changes no tracked
file and can never reach a commit. The gate already treats untracked scratch
as never blocking a close; the same reasoning says removing ignored paths is
not a repository change and should pass regardless of the card's state.

**Cost.** One refusal, one `ATELIER_BYPASS`, and this section written from a
different card's worktree because the one that owns the mess may not touch it.

## 13. The land step cannot remove the worktree it exists to remove

**What happened.** bw-2c0x.5 was the epic's land card: its whole content is
"remove the finished worktree and branch after every commit has reached the
landing branch". Closing it is the act that finishes it — and closing it is
what makes the removal impossible. Owned, the card cannot be closed while the
worktree it is meant to delete is still the one the session is standing in;
closed, `git worktree remove worktrees/bw-2c0x.5` and `git branch -D
bw-2c0x.5` from the main checkout are refused by `workflow-gate` as changes
without an owned card in an isolated worktree. There is no order that works.
The earlier siblings were removable only because a still-open card — this one —
was there to own the removal; the last one has nobody left to be owned by.

This is §12's shape one level out. §12 is a closed card's worktree unable to
throw away scratch *inside* itself; this is the removal of the worktree
itself, refused for the same reason: the card that would authorise it is the
card whose completion is the removal.

**Should have happened.** Removing a worktree whose card is closed, and
deleting a branch whose commits are already on the landing branch, throws away
nothing that is not already landed — the gate can check exactly that rather
than looking for an owner. Narrowly: `git worktree remove` and `git branch -D`
pass when the branch is an ancestor of the landing branch and its card is
closed. That is the same test `board/land` already makes before it closes a
card, so the information is on hand.

**Cost.** One refusal, one `ATELIER_BYPASS`, and — as in §11 — a card and a
worktree raised for the sole purpose of being allowed to write this section,
which will itself end in a land step with the same problem.

## 14. Ignored residue of a deleted directory is treated as a repository change

**Happened.** The release run failed at step 4/7 with
`no_node_runtime_is_started_extracted_or_downloaded_by_the_server`: "the
former Node backend still exists". `workbench/` did exist — but only because
`workbench/node_modules`, gitignored, had been left on disk when e823f79
deleted every tracked file under it. Nothing in git knew the directory was
there. `rm -rf workbench` from the main checkout was refused by
`workflow-gate` as a change needing an owned card in an isolated worktree.

**Should have happened.** A path with no tracked file under it and matched by
`.gitignore` is not a repository change; deleting it cannot lose anything the
landing branch holds. The gate already resolves the target; consulting
`git ls-files` and `git check-ignore` on it would let ignored residue be
removed without a card, exactly as `/dev/null` is already exempt.

**Cost.** One refusal, one `ATELIER_BYPASS`, and a release blocked by a
directory that the removal commit could not have deleted, because git never
carried it.

## 15. A land card can be neither claimed, worked, nor closed from anywhere

**Happened.** `board/land bw-3cmk.1` closed the work item and, after its checks
passed, opened `bw-3cmk.3 (land)`: "remove the finished worktree and branch".
From the main checkout, `git worktree remove` and `git branch -D` were refused
by `workflow-gate` (§13 again). `bd update bw-3cmk.3 --claim` was refused with
"claim it from its own isolated worktree" — a land card's whole purpose is to
delete the only worktree it could have. `bd close bw-3cmk.3` was then refused
by `board-status-gate` for the same want of an owned card in a worktree.

**Should have happened.** A card labelled `step:land` (or `no-code`) is work
on the main checkout by definition. The gates should accept claim, the two
git verbs named in §13, and close for such a card without a worktree, on the
same test `board/land` already makes: the branch is an ancestor of the landing
branch and its work item is closed.

**Cost.** Three refusals and three `ATELIER_BYPASS` invocations to finish a
pour the tool itself opened, plus this uncommitted edit to the friction book,
which no card can own either.

## 2026-09-07 — bd update --append-notes refused in the main checkout

workflow-gate refused `bd update bw-rx1y --append-notes=...` from the main
checkout ("Changes require an owned Beads work item in its isolated worktree")
seconds after `atelier tool board/job new` had created that epic from the same
place. Writing a card's notes is board metadata, the same kind of write job
new just made; it needs no worktree. Bypassed with a reason.

## 16. Landing cannot clear the main checkout it is required to merge into

**Happened.** `atelier tool board/land bw-rx1y.3` refused with a git merge
error: two e2e screenshots in the main checkout, `tests/results/edit-card-open
.png` and `-shut.png`, were uncommitted there and would be overwritten. The
worktree's own commit replaces both files — one of the two was already
byte-identical to the parked copy — so the merge's only obstacle was residue
from an earlier run of the very spec the card had just re-run. Discarding those
two paths in the main checkout with `git checkout --` was then refused by
`workflow-gate`: "Changes require an owned Beads work item in its isolated
worktree".

**Should have happened.** The land step already knows which paths its merge
carries. Restoring a tracked path in the landing checkout to `HEAD` when the
incoming commit rewrites that same path loses nothing the landing branch holds,
and is landing's own work rather than an agent editing outside its worktree —
so `board/land` should be allowed to do it, or should say plainly which paths
must be cleared and by whom.

**Cost.** Two refused land attempts, one `ATELIER_BYPASS` to reset two files
that the landing commit overwrote a second later, and a manual copy to `/tmp`
in case the gate was right and the worker was not.

## 17. A step:land card, met for a fourth time, plus a close it could not sign

**Happened.** `bw-ov7a.10`, the land step for the worktree epic. Claiming it
needed its own worktree, so one was cut; removing the job's worktrees from
inside one of them is impossible, so the removals were run from the main
checkout and `workflow-gate` refused them with "Changes require an owned Beads
work item in its isolated worktree (resolved target: /home/ahsan/dev/beads-web)".
`git branch -d` for the ten finished branches is the same refusal, since the
refs live in the common git directory. Then `bd close bw-ov7a.10` refused
twice over: once for the same want of a worktree, and once because the card's
assignee is the session actor (`s-c55ec765`) while `bd`'s actor is the git user
(`AhsanSarwar45`).

This is §13 and §15 again, unchanged, on a fourth job.

**Should have happened.** What §15 asks for: a card labelled `step:land` is
work on the main checkout by definition, so claim, `git worktree remove`,
`git branch -d` and close should be accepted there on `board/land`'s own test.
And a close should be signable by whoever the card says owns it, without
`BEADS_ACTOR` being restored by hand.

**Cost.** Three `ATELIER_BYPASS` invocations — the removals, the close of the
land card, and the close of the epic behind it — plus `BEADS_ACTOR` on the last
two, and this entry, which no card can own either.

## 18. A worktree belongs to a job, but the gate only knows cards

**Happened.** The manager's rule is that a worktree is cut per job and reused by
every child under it: one checkout for a whole epic, not one per step. Each
checkout carries its own `node_modules` and `tests/results`, so a per-step copy
costs gigabytes a step. Sixty-two of them had accumulated in `worktrees/`,
271 GiB in total, and btrfs ran out of room for metadata — 33.50 GiB allocated
against 4.00 GiB left unallocated on the device.

Cutting `worktrees/bw-jsou` for the job and claiming its first child inside it
was refused: "Claim bw-jsou.1 from its own isolated worktree, not
/home/ahsan/dev/beads-web/worktrees/bw-jsou." Atelier 0.22.0 reads the card ID
off the directory name and requires the claimed card to equal it. There is no
way to hold a job's copy and work its children through it.

Curiously, `machinery/hooks/__pycache__/workflow-gate.cpython-314.pyc` in this
repo — dated 2026-08-30, older than the 0.22.0 binary — carries the refusal
"Beads issue %s, or one of its epic children, must be claimed and in_progress
before this worktree may be changed." The clause the rule needs was written once
and is not in what runs.

**Should have happened.** The gate should accept a worktree named for a job when
the card being claimed or written is that job or one of its descendants. The
directory names the unit of isolation; the card names the unit of work, and
those are not the same size. Together with §13, which is why the copies are
never removed either, this is the whole of the disk problem: the gate makes a
copy per step mandatory and makes removing it impossible.

**Cost.** 271 GiB of worktrees, a btrfs metadata exhaustion on the manager's
machine, fifty worktrees removed by hand, and one `ATELIER_BYPASS` to claim the
child of the very card that writes this rule down.

## 19. A land is blocked by work abandoned in the landing checkout

**Happened.** `bw-g3o3.2`, landing after a rate-limited worker was resumed.
The rebase onto `ours` went through; the `git merge --ff-only` `board/land`
runs in the main checkout did not: "Your local changes to the following files
would be overwritten by merge: server/Cargo.lock, server/Cargo.toml". Those
changes were not mine and not this session's. They were uncommitted work left
in the landing checkout thirteen hours earlier by a session that never came
back — an `ignore = "0.4"` line for a `routes/fs_watch.rs` that does not exist
in the tree.

Nothing in the toolset gets past that. `git stash` is out, because the stash is
shared across every worktree and popping it elsewhere would take somebody's
work. Restoring the two files with `git checkout --` in the main checkout is
what a land needs, and `workflow-gate` refuses it: "Changes require an owned
Beads work item in its isolated worktree (resolved target:
/home/ahsan/dev/beads-web)". The gate is written against development in the
shared checkout, and cannot tell that apart from the land it is standing in the
way of — a land is by definition a write to the landing checkout, and
`board/land`'s own `git merge` is exempt while the one command that unblocks it
is not.

**Should have happened.** `board/land` should say what is dirty in the landing
checkout and offer to park it, or the gate should accept a `git checkout --` of
paths named by the merge it is refusing, from the worktree of a claimed card.
Failing both, an abandoned session should not leave its scratch in the one
checkout every other card has to merge through.

**Cost.** One `ATELIER_BYPASS`, the parked diff at
`~/.cache/atelier-parked/fs-watch-ignore-dep-2026-09-08.patch`, and this entry.
The discarded content was in fact the same dependency the landing commit adds,
so nothing was lost — but that had to be read off the diff by hand to know it.

**Seen again, same day.** The same abandoned session had also left
`src/lib/address.ts` in the landing checkout — the Files-tab address work,
byte-for-byte the same change as the `bw-g3o3.4` worktree that owns the card
carries, differing only in the wording of three comments. It would have blocked
that card's land for the same reason. Parked to
`~/.cache/atelier-parked/address-ts-stray-2026-09-08.patch` and restored under a
second `ATELIER_BYPASS`, before the land that would have hit it. The landing
checkout still carries ninety-odd regenerated `tests/results/*.png` from that
session, left alone for now because no pending land touches them.

## bw-gr8y.8 — removing a landed worktree is refused from the main checkout

The last step of a job is `git worktree remove worktrees/<job>` run from the
main checkout, and the gate answers:

> Changes require an owned Beads work item in its isolated worktree (resolved
> target: /home/ahsan/dev/beads-web).

By then the card is landed and closed and the worktree it names is the thing
being deleted, so there is no worktree left to be inside. Re-run under
`ATELIER_BYPASS` with that reason. Appending this note was refused the same way.

## bw-g3o3.12 — the workflow gate follows a `node_modules` symlink out of the worktree

A worktree here borrows the owner's installed packages with
`node_modules -> /home/ahsan/dev/beads-web/node_modules`, the way
`worktrees/bw-g3o3.2` does. This card adds a dependency
(`material-icon-theme`), which cannot go into the borrowed tree without writing
into the owner's checkout — so the symlink has to be replaced with a
worktree-local directory of symlinks plus the new package.

`rm node_modules`, run from inside the worktree, was refused:

```
Changes require an owned Beads work item in its isolated worktree
(target `node_modules` resolved from
/home/ahsan/dev/beads-web/worktrees/bw-g3o3.12 →
/home/ahsan/dev/beads-web/worktrees/bw-g3o3.12/node_modules).
```

The gate resolves the path through the symlink and lands in the main checkout,
so a write wholly inside the agent's own worktree — removing a link the agent
itself had just made — reads to it as a write into the owner's repository. Run
once with `ATELIER_BYPASS`. A gate that stopped at the first symlink, or that
treated a gitignored path as not the repository's, would not need one.

Second, smaller: `atelier tool board/land` merges into the main checkout, and
that checkout had eighty uncommitted lines in THIS file. The merge refused
("Your local changes to docs/hook-friction-2.md would be overwritten"), so a
card that records its friction here cannot land until whoever owns those lines
commits them. The note was moved out of the commit and appended by hand instead.

## bw-g3o3.8 — the workflow's own last step needs a bypass

The card's finishing instructions say, in as many words, to remove the spent
worktree from the main checkout:

```
git worktree remove worktrees/bw-g3o3.8
```

Run there, after the card had landed on `ours` and been closed, it was refused:

```
Changes require an owned Beads work item in its isolated worktree
(resolved target: /home/ahsan/dev/beads-web).
```

There is no worktree left to run it from — that is the whole point of the
command — and the agent no longer owns an open card, because landing closed it.
So the last step of the prescribed workflow can only ever be taken with
`ATELIER_BYPASS`, by every job, every time. `git worktree remove` is git
bookkeeping about a worktree the agent itself created; it changes no tracked
file in the owner's tree. A gate that let `git worktree remove worktrees/<own
job id>` through, or that stayed satisfied for the moments after a land, would
turn a standing bypass back into a real refusal.

The same refusal then covered appending this note, for the same reason.

## bw-gr8y.6 — landing is blocked by the landing checkout's own screenshot churn

`atelier tool board/land bw-gr8y.6` refused:

```
git merge failed: error: Your local changes to the following files would be overwritten by merge:
	tests/results/chat-opens-on-his-settings.png
	tests/results/escape-recall-after.png
	tests/results/escape-recall-before.png
	tests/results/mobile-chat-settings-after.png
	tests/results/sent-line-drawn-at-once.png
	tests/results/sent-line-once-after-echo.png
Please commit your changes or stash them before you merge.
Aborting
```

Six regenerated end-to-end screenshots were sitting uncommitted in the landing
checkout — eighty-nine such files were, and these six happen to be ones this
card also retook. The gate's own advice is "commit or stash exactly those", and
neither is open to a job: the stash is shared across every worktree on the
machine, so popping it elsewhere would take another agent's work, and the
landing checkout is nobody's card to commit on.

Restoring exactly those six was refused in turn:

```
Changes require an owned Beads work item in its isolated worktree
(resolved target: /home/ahsan/dev/beads-web).
```

So the job took the bypass, having first parked their diff at
`/tmp/bw-gr8y.6-parked-landing-screenshots.patch`. The friction is not really
the gate: it is that runs keep leaving regenerated pictures uncommitted in the
landing checkout, where every later land trips over them.

## bw-t9no — a job cannot close itself once its land step has run

The spine ends `work, checks, land`, and the land step's own acceptance is that
the worktrees and branches are gone. Closing it therefore leaves the job with
every child closed and no owned worktree anywhere, which is exactly the state
the job's own close is refused from:

```
Changes require an owned Beads work item in its isolated worktree
(resolved target: /home/ahsan/dev/beads-web).
```

Closing the job before the land step is refused too — `bw-t9no still has
unfinished children` — so the two closes cannot be ordered to satisfy both.
Putting the land card back to `in_progress` to buy a worktree was refused as
well, by the gate on the very worktree being reopened:

```
Beads issue bw-t9no.4 must be claimed and in_progress before this worktree is
changed. The resolved target: /home/ahsan/dev/beads-web/worktrees/bw-t9no.4.
```

Three bypasses came out of one shape: reopening the land card, closing the job
from the landing checkout, and removing the land card's own worktree, which for
the same reason cannot be removed from inside itself. A gate that let a job's
close through when all its children are closed, or that treated the land step's
own worktree as removable by the card that owns it, would leave the standing
refusals intact and cost this job nothing.

Repeated on `bw-2xjd.3`: the claimed `step:land` card was refused when it ran
`git worktree remove …/bw-2xjd.1` followed by `git branch -d bw-2xjd.1` against
its clean, already-landed work item. The refusal again resolved the Git write
to `/home/ahsan/dev/beads-web` and discarded the ownership of the worktree the
command was issued from. `board/land bw-2xjd.3` also cannot substitute for the
cleanup: it requires a commit named after a card the workflow itself marks
`no-code`.

## bw-e3dw.9 / bw-e3dw.2: a child working in its epic's worktree

The epic `bw-e3dw` keeps one worktree, `worktrees/bw-e3dw`, reused by every
child under it (a worktree is per job, not per step). Every write from inside
that copy is refused, because the gate resolves the target by the worktree's
NAME and looks for a card called `bw-e3dw` that this session owns:

```
Beads issue bw-e3dw is owned by AhsanSarwar45, not this session. The resolved
target: /home/ahsan/dev/beads-web/worktrees/bw-e3dw/tests/e2e/the-phone-rails.spec.ts.
```

The claim was refused first, for the same reason, and so was every subsequent
Edit and Write in the copy — one bypass per tool call for the whole card. A
gate that accepted a claimed child of the card the worktree is named after
would leave the standing refusals intact and cost this job nothing.

## bw-e3dw.6: the same refusal, now on a shell command that moves a file

Same worktree, same cause, one new shape. Capturing a "before" screenshot means
putting the working changes aside and driving the old app, so the card ran

```
git diff -- src > /tmp/e3dw6-src.patch && mv src/lib/keyboard-inset.ts /tmp/ && git checkout -- src
```

and was refused with

```
Beads issue bw-e3dw is owned by AhsanSarwar45, not this session. The target
`src/lib/keyboard-inset.ts` resolved from
/home/ahsan/dev/beads-web/worktrees/bw-e3dw → .../src/lib/keyboard-inset.ts.
```

Worth noting because it is not an Edit or a Write: a plain `mv` of a file the
card itself created a minute earlier is gated on the name of the directory it
sits in. Every other write in the card went through `ATELIER_BYPASS` for the
same reason as bw-e3dw.9 and bw-e3dw.2 above; the Edit and Write tools were not
attempted at all, since the previous worker recorded that they are refused
outright here and a heredoc through Bash carries the bypass.

## bw-e3dw.3 / bw-e3dw.5 — the epic copy refuses every write, including `cat > file`

The worktree is named for the epic (`worktrees/bw-e3dw`), so the gate reads the
job as `bw-e3dw` and refuses:

    Beads issue bw-e3dw is owned by AhsanSarwar45, not this session. The target
    `tests/e2e/the-git-diff-on-a-phone.spec.ts` resolved from
    /home/ahsan/dev/beads-web/worktrees/bw-e3dw → …/tests/e2e/the-git-diff-on-a-phone.spec.ts.

It refuses a plain shell redirection into a NEW file, not only an edit of a
tracked one, so `cat > …`, `sed -i`, and `mv` all need `ATELIER_BYPASS=` welded
onto the front of the command. The Edit and Write tools cannot be prefixed at
all and are simply unusable in a job copy, so every line of this card's work had
to go through Bash heredocs. A child claimed in its parent's copy has no
unrefused way to write a file.

## bw-e3dw.14/.15/.4 — the epic worktree refuses every write

The job copy is named `bw-e3dw`, so the workflow gate matches the child cards
against the epic and refuses. Every write in this worktree needs the bypass,
including plain housekeeping that touches no source:

    rm -rf tests/results/git-diff-reach/verify tests/.e2e-run-e3dw-14
    → Beads issue bw-e3dw is owned by AhsanSarwar45, not this session.

Deleting a scratch directory that the E2E run itself created a minute earlier
is not a write to the card's work, but the gate cannot tell the difference,
so the Edit and Write tools are unusable here and every line has to go through
a Bash heredoc with `ATELIER_BYPASS` welded on.

## bw-axtp.1 — the workflow gate reads the directory name as the card

The job is standalone: the directory is named for the job (`bw-axtp`) and the
only card in it is the child `bw-axtp.1`. The gate expects the directory name
to be the claimed card, so both the claim and every later write were refused.

`bd update bw-axtp.1 --claim` from `worktrees/bw-axtp`:

```
Claim bw-axtp.1 from its own isolated worktree, not /home/ahsan/dev/beads-web/worktrees/bw-axtp.
```

The first file write in the worktree:

```
Beads issue bw-axtp must be claimed and in_progress before this worktree is changed. The target `docs/hook-friction-2.md` resolved from /home/ahsan/dev/beads-web/worktrees/bw-axtp → /home/ahsan/dev/beads-web/worktrees/bw-axtp/docs/hook-friction-2.md.
```

Both carried through with
`ATELIER_BYPASS='a worktree is per job; this child is claimed in its job copy'`.

## bw-5gax — a refused command does not run its safe half either

Same shape as the epics above: the copy is named `bw-5gax`, so the gate reads
the directory name as the card and refuses every claim and every write, each
carried through with
`ATELIER_BYPASS='a worktree is per job; this child is claimed in its job copy'`
welded onto the front of the command — it does not carry from an earlier
`export`. Two things this job learnt that the earlier entries do not say:

**A compound command is refused whole.** Writing a spec with

    cat > /tmp/spec.ts <<EOF … EOF && cp /tmp/spec.ts worktrees/bw-5gax/tests/e2e/spec.ts

was rejected before any part of it ran, so even the write to `/tmp` — which
touches nothing the gate protects — never happened. The gate matches the
command text, not the effects, and a heredoc into a temporary file is invisible
to that. The way through is two steps: write the temporary file with the Write
tool (outside the worktree, so nothing to refuse), then `ATELIER_BYPASS=… cp`.

**A path outside the worktree is resolved as if it were inside it.** Cleaning
up trash entries the Rust tests had made on the owner's machine:

    rm -rf ~/.local/share/Trash/files/$f
    → Changes require an owned Beads work item in its isolated worktree
      (target `~/.local/share/Trash/files/$f` resolved from /home/ahsan/dev/beads-web
      → /home/ahsan/dev/beads-web/~/.local/share/...)

The `~` was never expanded — the shell had not run yet — so the gate treated it
as a relative path and joined it onto the repo root, then refused a path that
does not exist. An absolute path would have read better in the message, but the
refusal is the same; it went through with the bypass and a reason of its own.
## bw-axtp.3/.2 — the gate let this job through, and the bypass was the thing that broke a suite

Same shape of job as bw-axtp.1 above: one worktree named for the epic
(`worktrees/bw-axtp`), children claimed inside it. The refusals that card
recorded did **not** repeat. Measured, not assumed — each of these ran with no
`ATELIER_BYPASS` anywhere and was accepted:

- `bd update bw-axtp.3 --claim` and `bd update bw-axtp.2 --claim` from the job
  copy;
- `sed -i` and `cat >>` on files in `src/`, `tests/` and `docs/`;
- `git add -A` and `git commit` of the whole card.

The one refusal was `git worktree add worktrees/bw-axtp` run from the **main
checkout**, before the copy existed:

```
Changes require an owned Beads work item in its isolated worktree
(resolved target: /home/ahsan/dev/beads-web).
```

That one is the gate doing its job — cutting a worktree really does write into
the owner's repository — but it is also unavoidable, because a job copy cannot
be created from inside itself. Every job that starts with `git worktree add`
begins with a bypass, and a rule everybody must break on their first command
teaches them to reach for the bypass on every command after it. That is what
cost this job its only red (below). If one thing here is worth tuning, it is
this: `git worktree add worktrees/<job>` for a job the session owns should be
allowed outright.

## 7. `ATELIER_BYPASS` in the environment turns a declared suite red

**Attempted.** `atelier tool checks bw-axtp.2 --all`, in a shell where
`ATELIER_BYPASS` was still exported from the worktree-creating command.

**Result.**

```
checks: tree 126fcc81… Project checks=FAILED (821 passed, 1 failed)

thread 'a_compaction_beginning_reaches_the_file_the_screens_read' panicked at
tests/a_session_event_reaches_the_file_on_disk.rs:48:5:
the gate said something to the session: atelier doing stood down —
a worktree is per job; this child is claimed in its job copy
(via ATELIER_BYPASS in the environment)
```

The case asserts the gate says nothing to a session. With the bypass exported
the gate says it has stood down, that sentence reaches the session's file, and
the case fails. Nothing in the tree was wrong: the same tree with the variable
unset gives `Project checks=PASSED (890 passed, 0 failed)`.

**Why it costs.** The bypass is documented as a prefix — `ATELIER_BYPASS=… cmd`
— but a worker who exports it once, which is what a shell-shaped task
encourages, poisons every suite run afterwards, and the failure names a
compaction test rather than the variable. Both readings are now comments on
bw-axtp.2, because a red recorded and then explained is worth more than a red
quietly re-run away. Worth fixing at the source: the checks runner could strip
`ATELIER_BYPASS` from the environment it hands its subprocesses, since a suite
is never the thing the bypass is for.

## 8. `atelier tool checks --help` runs the checks

`atelier tool checks --help` does not print usage; it runs the project's whole
declared suite — `npm test && (cd server && cargo test)`, minutes of it —
against the current tree. There is no way to ask what the flags are without
paying for a full run.

## 9. The checks tool closes the card as the human, and cannot

After a green run, the last line of `atelier tool checks bw-axtp.2 --all` was:

```
bd close failed: cannot close bw-axtp.2: assignee is "s-70a116bd",
actor is "AhsanSarwar45"; reclaim or use --force to override
```

The tool claimed the card as the session (`s-70a116bd`, which is what
`bd update --claim` writes) and then tried to close it as the repository's
human owner. The evidence was recorded and the card was left open; closing it
took a `bd update --claim` and a `bd close` by hand. The tool should close as
the same actor it claimed as.

### …except on the land card, which is where it did repeat

The paragraph above holds for the work card and the checks card. The land card
is different: `bd update bw-axtp.4 --claim` from the job copy was refused with

```
Claim bw-axtp.4 from its own isolated worktree, not
/home/ahsan/dev/beads-web/worktrees/bw-axtp.
```

The two that were accepted differ from it in one visible way: they carry a
`copy:bw-axtp-2` label naming the branch the copy is on, and the land card
carries none. So the gate is not reading the directory name at all — it is
matching the card against a copy it has been told about, and a card that has
never been claimed anywhere has nothing to match. Which means the refusal lands
on the one card in the spine whose whole job is to take the copy away, and the
last command of every job is a bypass, just as the first one was.

`atelier tool board/land bw-axtp.4` then refused a second time, with
`no commit subject on bw-axtp-2 names bw-axtp.4` — a land card that removes a
worktree has, by its nature, no code to commit, so the only way to satisfy it
is to write something and name the land card in the subject. This commit is
that: honest about it rather than dressed up.

## bw-e3dw.7 / bw-e3dw.18 — the same refusal, one card later

Nothing has changed: the copy is `worktrees/bw-e3dw`, the cards worked in it
are `bw-e3dw.7` and `bw-e3dw.18`, and the gate matches the directory name
against the epic and refuses. Both cards were written entirely through Bash
heredocs with `ATELIER_BYPASS` welded onto each command — the spec, the CSS
rule, the four component files, the friction book itself, and the `rm` of the
scratch screenshots the runs left behind. The Edit and Write tools were not
attempted, since they cannot carry the prefix.

Two tool-shaped traps met on the same cards, neither of them a hook:

- `atelier tool checks --help` does not print help. It **runs the project's
  checks** and records the result as a comment on the card named by the
  surrounding job — the checks card here picked up a `checks: tree … FAILED`
  comment from what was meant to be a read of the usage line.
- `atelier tool board/job new --help` prints only `--what is required`, and
  every attempt to learn the rest of the flags by running it **creates a real
  epic**. Two throwaway cards (`bw-ikda`, `bw-z7wg`) had to be cancelled after
  probing for the flag names. A `--help` that answers, or a `--dry-run` that is
  honoured, would cost the board nothing.

## bw-e3dw.19 — the bypass the worktree forces on the worker turns a test red

**Happened.** `atelier tool checks bw-e3dw.19` recorded
`Project checks=FAILED (831 passed, 1 failed)`. The one failure was
`server/tests/a_session_event_reaches_the_file_on_disk.rs`:

    thread 'a_compaction_beginning_reaches_the_file_the_screens_read' panicked
    at tests/a_session_event_reaches_the_file_on_disk.rs:48:5:
    the gate said something to the session: atelier doing stood down — a
    worktree is per job; this child is claimed in its job copy (via
    ATELIER_BYPASS in the environment)

The case asserts the gate says nothing to the session it drives. Every write
in this copy has to carry `ATELIER_BYPASS`, and once it is exported into the
shell rather than welded onto one command, the gate stands down **out loud**
and the test reads its message as the gate having spoken. Re-run on the same
tree with `env -u ATELIER_BYPASS`, the same command gives
`Project checks=PASSED (900 passed, 0 failed)`.

**Should have happened.** Either the gate should stand down silently when it
is bypassed, or the checks step should run the project's command in a clean
environment. As it is, the two instructions a worker in a job copy is given —
"weld the bypass onto every command" and "run the declared checks and record
what you get" — produce a red that belongs to neither the change nor the app.

**Cost.** One FAILED recorded on the checks card, one full re-run of
`npm test && (cd server && cargo test)`, and a note on the card so the red is
not read as the epic's.

## bw-wk5u — the claim of a child in its epic's worktree

**What happened.** The worktree for this job is cut once and named for the
epic (`worktrees/bw-wk5u`), which is what "a worktree is per job, not per
step" asks for. The first write refused:

    Claim bw-wk5u.1 from its own isolated worktree, not
    /home/ahsan/dev/beads-web/worktrees/bw-wk5u.

**Should have happened.** The gate reads the worktree's name and wants it to
be the card's. A copy named for the epic holds every child of that epic, so
the check could be "is this card in the job this copy is named for" rather
than "is this card's own id the folder name". As it stands the two standing
instructions disagree, and every claim and every land in a job copy has to
carry `ATELIER_BYPASS` to get past it.

**Cost.** A refusal on every claim and every land in this job — three cards,
plus the spine's checks and land cards.

## bw-8qrr — the Edit and Write tools cannot carry a bypass

**What happened.** A job copy named for its epic (`worktrees/bw-8qrr`) refuses
every write until the epic itself is claimed, which is the friction recorded
for bw-wk5u above. The documented answer is to weld `ATELIER_BYPASS='why'`
onto the refused command. But `workflow-gate` also judges the Edit and Write
tools, and a tool call has no command line to weld an assignment onto:

    Beads issue bw-8qrr must be claimed and in_progress before this worktree
    is changed. The resolved target:
    /home/ahsan/dev/beads-web/worktrees/bw-8qrr/server/src/routes/git.rs

So the narrowest switch the table in `docs/hooks.md` offers — one command, with
its reason — is the one switch that cannot be reached for the tools an agent
edits with. The wider ones (`ATELIER_BYPASS` in the environment,
`ATELIER_HOOKS=off`, a `.atelier-hooks-off` file) all cover far more than the
one edit and say far less about why.

**Should have happened.** Either the gate accepts a claimed descendant of the
card the copy is named for — which is the bw-wk5u fix and would end this too —
or Edit and Write learn to read a reason from somewhere a tool call can put
one, so the narrow switch is available where most of the writing happens.

**Cost.** Every source edit in this job was made by piping a Python script
through `bash` with the bypass welded on, instead of by the tools meant for
it: eight patch scripts for what were ordinary edits, each one a place a
mistyped anchor string could have silently matched nothing.

**Still happening — bw-ad3r.** The same two refusals, unchanged, on a job of
fourteen cards: every `bd update --claim`, every `git add`/`git commit`, and
every source edit. The cost this time was fifteen-odd patch scripts piped
through `bash` in place of Edit, and a bypass reason repeated on every line of
the job. Worth noting because the shape of the work makes it worse, not better:
this job is one epic with many small children, which is exactly the shape the
worktree-per-job rule was written to encourage, and it is the shape the gate
punishes hardest.

**Still happening — bw-oamr.** Unchanged again, on a three-card job. The first
refusal came before any source was touched: `bd update bw-oamr.3
--append-notes` was refused from the main checkout with "Changes require an
owned Beads work item in its isolated worktree", which is right, and then the
same command was refused from the job copy because the copy is named for the
epic and the claim is on a child. Recording a note on a card is not a
repository change at all, which makes this the clearest case yet that the gate
is reading the wrong thing: nothing in `bd update --append-notes` writes a
tracked file.

Every `Edit` call in the job was refused the same way and re-done as a Python
script piped through `bash` with the reason welded on — the same workaround the
bw-8qrr and bw-ad3r entries above describe, for the same reason: a tool call
has nowhere to put a per-command reason. Worth adding only because the count
keeps climbing and the fix has not moved: four jobs now (bw-wk5u, bw-8qrr,
bw-ad3r, and this one) have paid the same price in the same way.
