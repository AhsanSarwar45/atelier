---
description: Clean up & improve docs and code comments — remove outdated, duplicate, fluff, and historical-leftover content
argument-hint: "[path or glob — defaults to whole repo] [--apply | --dry-run]"
model: sonnet
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent, Skill, mcp__code-review-graph__semantic_search_nodes_tool, mcp__code-review-graph__query_graph_tool
---

# docs-cleanup — prune & sharpen docs and comments

Runs on **Sonnet**. Goal: make this project's prose and its code comments
leaner and more correct **without losing any load-bearing fact**. You **delete
rot, you do not rewrite meaning**.

## Scope

- `$ARGUMENTS` may name a path/glob to limit scope. **No path → whole repo.**
- `--dry-run` (DEFAULT): produce a change report, edit nothing.
- `--apply`: make the edits after the report.
- Never touch: `target/`, `vendor/`, `worktrees/`, `.git/`, generated files,
  lockfiles, `data/*.sqlite`.

## The prime directive — ONE FACT, ONE HOME (read `CLAUDE.md`)

This repo's hard rule: **a fact lives in exactly one file; everywhere else
LINKS to it.** So your cleanup obeys these, in priority order:

1. **Never delete the ONLY home of a fact.** Before removing a "duplicate",
   confirm the fact survives in its owning doc. If the copy you're cutting is
   the *only* place a number/caveat exists, MOVE it to the owner and link —
   don't drop it.
2. **Preserve every sourced value.** A number with a citation, a `GENUS`, a
   measured threshold, a primary-source reference → keep verbatim. Sourced
   data is never "fluff".
3. **Link, don't restate.** When two docs state the same fact, keep it in the
   more-specific owner and replace the other with a one-clause link to the
   anchor.

## What to REMOVE

- **Outdated / wrong** — statements the code no longer matches (verify against
  the symbol via code-review-graph / Read before calling it stale).
- **Duplicates** — the same fact stated in 2+ places → collapse to owner+link.
- **Fluff** — restating the question, "as we can see", "basically/simply/just",
  decorative recaps, obvious-from-code comments (`// increment i`), praise.
- **Historical leftovers** — "previously we did X", "used to be", "after the
  refactor", changelog-in-a-comment, dead TODO for shipped work, commented-out
  code with no explanatory value, migration notes for finished migrations.
- **Session state in a document** — what is being tried, what was found, what
  is next. It belongs on the board and nowhere else (`CLAUDE.md`): move it onto
  the card it belongs to, keep only what outlives the work, and delete the rest.

## What to KEEP (do not touch)

- `WHY` comments (rationale for non-obvious code), invariant assertions,
  safety/perf gotchas, links to facts, anchors/tags other files point at.
- Sourced numbers, citations, and anything the project names as a rule or as
  reference material about the world outside it. When unsure whether a fact is
  load-bearing → **keep it and note it in the report**, never guess-delete.
- Anything a code comment says is the *only* home of a doc-owned fact — flag it
  to move, don't silently cut.

## Procedure

1. **Enumerate** in-scope files (`Glob`/`git ls-files`). Group: markdown docs
   vs. source comments. Report the count.
2. **Fan out on Sonnet** — for a large scope, delegate batches to
   `general-purpose`/`scout` agents (each returns a per-file findings list:
   `file:line — category — proposed change — is-this-the-only-home?`). Heavy
   reading dies in the agent; only findings return. For a small scope, do it
   inline.
3. **Cross-file dedup pass** — collect all findings, detect facts appearing in
   multiple files, pick the owner (most-specific file), mark the rest as
   link-or-move.
4. **Report** — grouped by category (outdated / duplicate / fluff / historical
   / stale-handoff), each finding with `file:line`, the current text, the
   proposed edit, and a KEEP-flag for anything uncertain. Give a one-line
   summary count per category.
5. **Apply** (only if `--apply`): make edits with `Edit`. For moved facts,
   write to the owner first, then cut the copy and insert the link. Never leave
   a dangling `[[link]]`/anchor. Do not reformat untouched lines.
6. **Verify** — after applying, run `git diff --stat`. Confirm no doc lost its
   only copy of a fact. If any `docs/*.md` link anchors changed, grep for
   referers. Report what changed and what you deliberately kept.

## Guardrails

- **Working tree is SHARED** — never `git stash`/`checkout`/`reset` to A/B.
  Edit in place. A WIP commit is the only rollback.
- If the scope crosses >~15 files, do `--dry-run` first and surface the report
  before applying, even if `--apply` was passed.
- A wrong doc is worse than no doc, but a *deleted* fact is worse than a wordy
  one. When the two conflict, **keep the fact, trim the words.**
