# Project skill switches QA

Scope: project-local skill/command enablement must persist without mutating global sources or other projects. Main regression risks are losing customizations, hiding unavailable skills, stale writes and runtime access to disabled items.

## Planned matrix

- Global folder, global text, project folder and project text: off, reload, keyboard on.
- Global command: off, reload; another project and global source remain unchanged.
- Existing customization survives toggles; Reset to global removes it.
- Missing prerequisite stays unavailable after off/on, while the switch remains usable.
- Stale settings save refuses overwrite and preserves newer source.
- Layout at 390, 768, 1024, 1280 and 1920 pixel widths, accessible switch names and Space activation.
- Runtime exclusion and explicit-read refusal: companion backend verification.

## Baseline

Old packaged worktree binary, isolated ports 46740/46741, Playwright-owned Chromium context. Before screenshot `tests/results/project-skill-enablement/before.png` captured before frontend changes. Durable asset: `54738558e3283886640ab953bea14d7780f3efeb385ba1bfe7ac7ef97a1efca4.png`. Harness exited and both ports were free.

## Results

Updated-binary Playwright pass: both tests in `project-skill-enablement.spec.ts` passed. Four storage/source combinations survived off/reload/keyboard-on; custom content survived toggles; Reset removed the override; command disable remained project-only; stale writes did not overwrite newer content; missing prerequisites remained unavailable after re-enabling. Actual migrated project instructions and skill/support files were copied into a disposable registered project and discovered without native provider files.

Screenshots at all five planned sizes were captured and document-level horizontal overflow assertions passed. Switches remain labeled and keyboard operable. After asset: `f8b6e62e6b01dac83bef05e1977bd1a5e949f2e539f6b652a0dcb91fae9cbcb7.png`. Expected stale-save refusal was exercised deliberately, not counted as an unexpected network failure.

Initial test failures were fixture errors: the second project was not registered and the migration fixture lacked `.atelier/project.toml`. Corrected fixtures pass; API trims instruction trailing whitespace, so the expected source is trimmed.

## Coverage limits and observations

The available Chrome MCP could navigate and expose the accessibility tree in its own `project-switch-qa` context, but saving screenshots was refused by its workspace boundary and its subsequent screenshot call stalled. That call was terminated. No MCP screenshot acceptance is claimed; rendered Playwright screenshot evidence was inspected separately.

At 390px, the existing long folder-source description visibly clips inside the card while switches themselves remain readable and operable. This was reported to the implementing agent for assessment; the document-level overflow check alone does not establish that all text is unclipped.

No model workflow is executed by these browser tests. Runtime catalog/read/explicit invocation exclusion is covered by the companion backend tests and separate provider migration verification. Screen-check uploads are captures with no visual judgment, not PASS verdicts.
