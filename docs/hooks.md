# Hooks: what they enforce, and how to get past one

Every gate Atelier installs is native: `atelier hook <name>`, wired from
`.claude/settings.json`. There is no interpreter and no script under
`machinery/` to run — a hook name the binary does not know stands down.

This file exists because a rule an agent meets only by being refused is a rule
that costs a round trip to learn. `docs/hook-friction.md` §5 is the standing
complaint; this is the answer to it.

## The escape hatch

**Every hook honours the same bypass, and every use is announced and logged.**
An agent that has argued itself into a corner, and an owner who has decided the
gate is wrong this once, use the same four switches:

| Say it | Where | Good for |
| --- | --- | --- |
| `ATELIER_BYPASS='why' <command>` | as a leading assignment on the very command being gated | one command |
| `ATELIER_BYPASS=why` | in the environment | one session or one shell |
| `ATELIER_HOOKS=off` | in the environment | one session; also `0`, `false`, `no`, `none`, `disabled` |
| a `.atelier-hooks-off` file | any ancestor of the working directory; its contents are the reason | one tree |
| a `hooks-off` file | Atelier's data directory | the whole machine |

A Stop gate has no command to carry an assignment, so it reads one off the
reply instead: a line of its own saying `ATELIER_BYPASS=why` in the message the
gate is judging stands the gate down.

Whichever route is used, the hook prints
`atelier <gate> stood down — <reason> (via <source>)` on stderr and appends the
same line, timestamped, to `hook-bypass.log` in Atelier's data directory. The
bypass is loud on purpose: it is an escape hatch, not a way to work.

Prefer the narrowest one that clears the block. `ATELIER_BYPASS` on a single
command says which command and why; `ATELIER_HOOKS=off` says nothing and covers
everything.

## The gates

### `workflow-gate` — PreToolUse on Bash, Edit, Write, MultiEdit, NotebookEdit

Repository changes need an owned Beads card, made in that card's isolated
worktree. What it counts as a change is wider than editing a file, and this is
the part the beads skill never said:

- **Shell redirects are changes.** `foo > bar` is judged on `bar`, and so are
  `>>`, `&>`, `&>>`, `>|`, and the file `tee` is given.
- **Git verbs that write are changes**, judged on the repository they write:
  `add am checkout checkout-index cherry-pick clean commit fast-import
  filter-branch merge mv pull read-tree rebase reset restore revert rm switch
  update-index update-ref`, plus `push`, `symbolic-ref`, `replace`, `notes`,
  `sparse-checkout`, `reflog` and `submodule` when their arguments write. Reads
  are never gated. The list covers plumbing deliberately: a gate that stops
  `git merge` but not `git update-ref` selects for agents who know the
  plumbing, which is not a security boundary (`docs/hook-friction.md` §4).

What it does **not** count, each of which used to cost a round trip:

- **Starting a card.** `git worktree add worktrees/<ID> -b <ID>` builds the
  isolation the rule demands, and `bd update <ID> --claim` is how a card becomes
  owned; refusing them made the state the gate requires unreachable from a clean
  start. The documented opening passes as one line — make the worktree, step
  into it, claim the card — including the claim into the worktree that same line
  creates. Both carve-outs are exact: another `worktree` subcommand, a
  destination outside the project, a branch that is not the card, or any command
  on the line that writes something, and the line is judged normally
  (`docs/hook-friction-2.md` §3).

- **Anything that is not a real file.** `/dev/null`, `/dev/tcp/host/port`,
  `/proc`, `/sys`, `>&2`, and process substitution are not writes. Silencing a
  command and probing a port are ordinary and ungated (§1, §2).
- **Text that merely names a path.** The command is tokenised, not searched:
  heredoc bodies, quoted strings and commit messages are data. Writing a
  document that discusses `/etc/passwd` is writing a document (§3).
- **Anywhere outside a Git worktree.** A path in no repository is not a change
  to anybody's work; scratch directories and `/tmp` are free.

A refusal names the target as the command wrote it, the directory it was
resolved against, and where it landed — the resolution is usually the whole
explanation, and a background command that starts in the main checkout rather
than your worktree is the case where it matters
(`docs/hook-friction-2.md` §2).

### `board-merge-gate` — PreToolUse on Bash

Polices a landing rather than forbidding one. A `git merge --ff-only` of your
own card branch into the main branch, from the checkout that holds it, is the
landing the workflow asks for and it passes the workflow gate to arrive here.
This gate then requires that it really is a fast-forward, that nobody else
holds the merge slot, and that the landing does not overwrite uncommitted work
— and it names the files it would overwrite, rather than refusing any dirty
tree.

`atelier tool board/land CARD-ID` does all of this for you, including the slot.
Reach for the raw merge only when that fails. The lander acts as the card's own
assignee, so closing work you own is not read as somebody else closing it, and
it is safe to run twice: if the commits already reached the landing branch it
says so and finishes the close rather than reporting a naming failure
(`docs/hook-friction-2.md` §4).

### `board-status-gate` — PreToolUse on Bash

Guards `bd` status moves: a card in the manager's column is the manager's to
move, and a card cannot be closed over uncommitted changes to tracked files.
Untracked scratch never blocks a close. The card being judged is the card the
command names, wherever it sits among the flags — `bd update --status closed
CARD` is about `CARD`, not about `closed`.

### `board-actor` — PreToolUse on Bash

Stamps the acting session onto `bd` calls. It rewrites the command; it does not
refuse one.

### `board-gate` — Stop

Refuses a turn that closes work whose named commit has not landed, or a parent
with unfinished children.

### `completion-gate` — Stop

Refuses a reply that hands the work to a later session in so many words
("future session", "left for later", …). Say the concrete blocker and what
input it needs instead.

### `board-touch`, `board-prime`, `board-push`, `doing` — bookkeeping

Keep the board and the session's activity in step. None of them refuses
anything. `board-touch` fires on nearly every tool call, so it does at most one
board round trip per 45 seconds per session and project.

`doing` is the odd one: it serves chats Atelier does **not** drive. A chat this
app drives over ACP reports what it is doing on the wire — tool calls,
permission requests, modes, usage — and a saved chat is discovered and replayed
over ACP too (`session/list`, `session/resume`). But `SessionInfo`, all ACP
returns for a chat nobody is driving, is an id, a folder, a title and a clock;
there is no state on it and no method in the protocol to ask for one. Claude
Code's own marker carries a single bit, busy or idle. So a compaction in
progress and a permission prompt waiting for an answer are visible from nowhere
but inside the session, and `doing` writes those two — and only those two — to
`<claude>/sessions/<id>.doing.json` for the screens to read.

**Two events, one per state.** `PreCompact` and `Notification`, and nothing
else. A claim ends when the conversation writes its next line, which the reader
already watches for: measured on fourteen real compactions, a record is silent
for 97 to 186 seconds while one runs and speaks the moment it finishes. It used
to take `PostCompact`, `Stop`, `PostToolUse`, `UserPromptSubmit` and
`SessionEnd` as well, all of them saying only "something happened" — which the
record says by itself. A line left behind by a session that was killed is swept
by the reader, which is the one thing a hook could never do.

It is registered with every other gate here, in the **project's own**
`.claude/settings.json`, by `atelier init`. Until 2026-09 it wrote itself into
the reader's global `~/.claude/settings.json` at every startup instead — one
file for every project on the computer, edited by a program they had only
started. `atelier init` now takes those old registrations back out and says how
many it removed.

## When the gate is wrong

Use the bypass, finish the work, and add a numbered section to
`docs/hook-friction.md` — or `docs/hook-friction-2.md`, which exists so two
agents can write at once — saying what you attempted, what came back, and why
the refusal did not serve the rule it was enforcing. That file is the input to the
next round of tuning; the bypass log is only evidence that something happened.

## Changing a gate

The gates live in `server/src/lifecycle.rs`, the bypass in
`server/src/hook_bypass.rs`, and the dispatch in `server/src/rules.rs`. They run
from the **installed** `atelier`, not from a worktree build, so a fix is not in
effect until `scripts/install-local.sh` is run from a terminal outside Atelier.
