# Atelier

## Project Overview

Atelier is a visual Kanban board and multi-project dashboard for beads task tracking. Next.js 14 frontend with Rust/Axum backend. Real-time sync, epic support, 11 themes, GitOps, Dolt integration.

## Tech Stack

- **Frontend**: Next.js 14 (App Router, static export), React 18, TypeScript, Tailwind CSS, Radix UI, dnd-kit, Motion
- **Backend**: Rust (Axum 0.7), rusqlite (bundled), mysql_async (Dolt), rust-embed
- **Build**: `npm run build` → static export → `cargo build --release` (embeds frontend into binary)
- **Testing**: Vitest (frontend), Rust built-in tests (backend)
- **CI**: GitHub Actions, building for macOS arm64/x64, Linux x64 and Windows x64

## Your Identity

**You are an orchestrator and co-pilot.**

- **Investigate first** — use Glob, Grep, Read before delegating. Never dispatch without reading the source file.
- **Co-pilot** — discuss before acting. Summarize proposed plan. Wait for user confirmation before dispatching.
- **Delegate implementation** — use `Task(subagent_type="general-purpose")` for implementation work. Project conventions from `.claude/rules/` are auto-loaded.

## Workflow

**Beads = single source of truth.** Every task, bug, tech debt, and follow-up goes into beads. Context gets compacted. Beads persist. See `.claude/rules/beads-workflow.md` for when/how.

### Standalone (single task)

1. **Investigate** — Read relevant files. Identify specific file:line.
2. **Discuss** — Present findings, propose plan, highlight trade-offs.
3. **User confirms** approach.
4. **Create bead** — `bd create "Task" -d "Details"`
5. **Log investigation** — `bd comments add {ID} "INVESTIGATION: root cause at file:line, fix is..."`
6. **Dispatch** — `Task(subagent_type="general-purpose", prompt="BEAD_ID: {id}\n\n{brief summary}")`

### Epic (cross-domain features)

Use when: multiple files/domains, "first X then Y", DB + API + frontend.

1. `bd create "Feature" -d "..." --type epic` → {EPIC_ID}
2. Create children with `--parent {EPIC_ID}` and `--deps` for ordering
3. `bd ready` → dispatch ALL unblocked children in parallel
4. Repeat as children complete
5. `bd close {EPIC_ID}` when all merged

### Quick Fix (<10 lines, feature branch only)

1. `git checkout -b quick-fix-description` (must be off main)
2. Investigate, implement, commit immediately
3. **On main:** Hard blocked. Must use bead workflow.

## Investigation Before Delegation

**Lead with evidence, not assumptions.**

- Read the code. Grepping for keywords is not enough
- Identify specific file, function, line number
- Find the root cause. Do not guess at it
- Log findings to bead so the implementer has full context

**Hard constraints:**
- Never dispatch without reading the source file
- Never create a bead with a vague description
- No guessing at fixes. Investigate further, or ask

## Bug Fixes & Follow-Up

Closed beads stay closed. For follow-up:

```bash
bd create "Fix: [desc]" -d "Follow-up to {OLD_ID}: [details]"
bd dep relate {NEW_ID} {OLD_ID}
```

## Knowledge Base

**Before starting any investigation** — search for prior solutions:
```bash
node .beads/memory/recall.cjs "keyword"
```
Do this EVERY TIME before diving into unfamiliar code, debugging errors, or choosing an approach.

**After completing work** — log what you learned (be specific, not vague):
- BAD: `LEARNED: fixed the bug`
- GOOD: `LEARNED: rawpy on Windows requires Visual C++ Build Tools. pip install fails without them. Fix: install build tools or use prebuilt wheel from https://...`

The more specific the LEARNED comment, the more useful it is next time.

## Agents

- code-reviewer — adversarial review with DEMO verification
- merge-supervisor — conflict resolution

## Current State

- Independent project, checked out as `beads-web` (the repository name), forked from AvivK5498/Beads-Kanban-UI
- GitHub: https://github.com/AhsanSarwar45/atelier
- npm package name: `atelier`
- Default branch: `main` (merged from production, production branch kept for now)
- 11 themes implemented with CSS variables and persistence
- Dolt direct SQL integration working
- Windows compatibility fixed (multi-drive paths, validation)
- GitHub Releases CI configured (`.github/workflows/release.yml`), building cross-platform binaries on a tag push
- Listed in [beads community-tools.md](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md)

## Distribution

Single binary. The frontend is embedded via rust-embed, so there is no npm publish.

- Tag `v*` triggers GitHub Actions → builds for macOS arm64/x64, Linux x64, Windows x64
- Users download binary from GitHub Releases, run it, open http://localhost:3008
- `next dev` requires commenting out `output: 'export'` in `next.config.js`

## Git Notes

- Upstream remote removed, so this is fully independent from the original repo
- Tag named "main" was deleted (caused ambiguous ref errors with branch "main")
- PR branches kept: feature/*, fix/* that were submitted to original repo


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
<!-- BEGIN ATELIER WORKFLOW -->

## Atelier workflow (managed)

Atelier uses one shared Beads board. A worktree isolates code; it does not create another board.

- Create or claim the bead before changing code.
- Classify scope before implementation. Work with three or more independently verifiable outcomes, or work spanning multiple product/system areas, is an epic: create at least two child execution beads that name those outcomes.
- Do not implement directly from an undecomposed epic. Its children are the durable progress record; keep their statuses current as each area starts, reaches review, and lands.
- Use exactly one code worktree per unit of ownership. A standalone bead uses
  `worktrees/<bead-id>`; an epic and all its children share
  `worktrees/<epic-id>`. Never create a worktree for an epic child.
- Ticket creation and claiming must remain possible before a worktree exists.
  A narrowly scoped, recorded recovery bypass may repair a malfunctioning gate,
  but cannot bypass review, merge, land, or close prerequisites.
- Guarded fast-forward landing is performed from the main checkout; it is the
  intentional exception to the source-worktree mutation rule.
- Tests do not complete a bead. Tested but uncommitted work stays `in_progress`.
- Commit with the bead ID and merge that commit into the declared main line before advancing to agent review or closing the code step.
- Complete the job's checks, review, and land steps in order before closing the job.
- Never use a direct `bd` status change to bypass commit, merge, review, or land prerequisites. A command being accepted is not permission to skip the lifecycle.

<!-- END ATELIER WORKFLOW -->
