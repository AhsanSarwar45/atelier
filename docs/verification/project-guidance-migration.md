# Project guidance migration

This repository uses `.atelier/instructions.md` for its project baseline.
The existing setup, build and visual-evidence requirements are preserved;
the unique policies from `AGENTS.md` are appended. `CLAUDE.md` contained only
the same isolated-app policy, so it is not duplicated.

The complete `.agents/skills/beads/` folder moves to `.atelier/skills/beads/`:
`SKILL.md` and `agents/openai.yaml` are byte-identical to their originals.
Automatic skill behavior is unchanged. Its workflow body also appears in the
built-in `atelier-beads` instructions; the project skill remains available as
`beads` rather than silently discarding its description and supporting metadata.

There were no project-native commands, additional skills or symlinked assets.
Provider hook/settings files and shipped `machinery/skills/` are not migrated
or removed. The main checkout's untracked `.claude/RESUME.md` is historical
handoff material and remains untouched.

The retired tracked guidance is recoverable from Git commit `0437cad7` using
`git show 0437cad7:PATH`. No untracked provider files were deleted. New or
reconnected Atelier sessions pick up the project sources after landing.

## Provider delivery proof

`tests/e2e/project-guidance-migration.spec.ts` passed for fresh Claude and Codex
sessions on isolated ports 46742/46743. The fixture contained this repository's
Atelier instructions and complete beads skill, but no native instruction files.
Both providers reported protected port 3008 and the screenshot-based evidence
requirement from injected context, then used `atelier_skill_read` and read the
pinned skill's `agents/openai.yaml`. Both returned its exact short description,
`Project task tracking with bd`. The prompt did not supply these expected values.

The captured screens were inspected: `tests/results/project-guidance-migration/claude.png`
and `codex.png`. Both show the skill read, supporting-file read and final answers.
Two tests passed in 42.1 seconds; both isolated ports were free after cleanup.
This is provider-delivery proof, not a claim that the workflow was executed or
that unrelated responsive/keyboard behavior was retested.
