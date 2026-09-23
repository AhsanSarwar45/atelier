# Shared guidance verification — bw-yi74.3

## Browser and provider evidence

Tested on 2026-09-23 against disposable worktree-local stacks, not the owner's
application. Chrome DevTools MCP drove real browser navigation, keyboard input,
editor clicks, screenshots and browser-side API inspection. Playwright supplies
repeatable regression assertions in addition to that exploration.

| Scenario | Evidence |
| --- | --- |
| Delete one resource then add another without losing the surviving value | Chrome reproduced the defect and verified the fix; resource-before.png / resource-after.png; automated save/reload and nested Unicode filename case |
| Reset inherited parameters; remove project-only parameters | Chrome reset saved an empty override map; browser regression verifies later global values remain inherited |
| Concurrent saves and changing global source | Browser regressions reject stale writes, preserve the draft and reload explicitly; project source revisions are checked under the library write lock |
| Conditions | Browser JSON/TOML/YAML/dependency/nested conditions, invalid YAML and unavailable tools; Rust positive/negative/missing-data matrix, monorepo binding, ignored paths, symlink escapes and unknown propagation |
| Source removal and ID conflicts | Browser orphan cleanup, conflict refusal and unrelated available item preservation |
| Automatic skill discovery | Both real providers selected the release skill from its description without an explicit skill ID and read its nested resource through MCP |
| Connection pinning | Both real providers returned JSON with RELEASE-V1 / GLOBAL-V1 after the source and selected style changed |
| Close/resume refresh | Both real providers returned PIPE with RELEASE-V2 / GLOBAL-V2 after actual provider close/resume, not merely browser reload |
| Manual-only skill | Both providers accepted /skill:manual-audit, used ALPHA parameters and the selected pipe style; automatic catalogue excludes manual-only descriptions |
| Cross-project isolation | Both providers rejected the conditional skill in Beta and returned PIPE / MANUAL-V1 / BASE / GLOBAL-V2 / BETA for its manual skill |
| Existing feature regression | Original browser cases cover both editors, native import, output-style selection, immutable MCP reads and explicit skill/resource delivery to both providers |
| Connection context transport | Rust test exercises Claude, Codex and Local branches, rejected-send retry, once-per-connection delivery and unchanged stored user text |

Provider screenshots in `tests/results/shared-library/claude-chrome-lifecycle.png`
and `codex-chrome-lifecycle.png` show the JSON-to-pipe transition and subsequent
manual skill response. They were acquired through Chrome DevTools MCP and read
visually; they are not screenshots of a mocked response. The matching E2E cases
assert the returned fields and text, rather than only the presence of an answer.

## Defects corrected

- Resource addition reused an occupied generated key after deletion, overwriting
  surviving content.
- Project parameter removal merged old overrides back in; unchanged/reset fields
  could remain pinned instead of inheriting subsequent global edits.
- A stale project editor could save against a global source that had changed.
- Preview requests could resolve out of order and replace the current scope.
- Resumed providers read new skill resources but continued using old shared
  instructions/style. The common ACP connector now sends current guidance at
  the first accepted turn of each connection, in addition to session metadata.

## Limits and provenance

Claude and Codex used real installed runtimes and isolated credential copies.
Local/Goose's adapter is installed, but neither localhost:8080 nor :11434 had a
model runtime. Local's common transport is tested; real Local model behavior is
**not verified**. An accessible endpoint and model are required for that final
live-provider case.

The installed `atelier` on the host predates the skills CLI. One Codex turn tried
that old CLI, received `skills is not an Atelier workflow tool`, then successfully
used the current build's MCP tool. The current binary's CLI/MCP reader is covered
by the regression suite; no owner's installation was changed for this test.
The non-Beads fixture projects return 404 from board discovery, as expected.
Initial WebSocket-close warnings were observed during navigation; completed
turns, refreshed revisions and persisted results were checked separately.

An intermediate run rebuilt Cargo while the app was alive, invalidating its
executable path for new MCP subprocesses. Final regression runs use an immutable
copy of the built executable. Never rebuild or replace a live test artifact.

## Reproduction

Build the frontend and server, copy the executable into an ignored worktree-local
artifact directory, and run `scripts/workbench-e2e.sh` with that `ATELIER_BINARY`,
two explicitly probed free ports, `BEADS_E2E_LIVE_PROVIDERS=1`, and a unique
`WORKBENCH_E2E_RUN`. Supply both `tests/e2e/shared-library-edge-cases.spec.ts` and
`tests/e2e/shared-library.spec.ts`, with `--workers=1`. The harness owns cleanup.

For manual Chrome exploration, use `shared-library-lab.spec.ts` with
`BEADS_LIBRARY_LAB=1`. Read its generated `lab.json`; finish by creating the
run-local `lab-complete` marker. The lab's waiting test is not counted as feature
coverage. Full declared suites and independent review are recorded on the card
against the committed tree.
