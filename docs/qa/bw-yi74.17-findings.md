# Skill deletion QA

Scope: delete complete local/global skill folders and text skills from their own settings scope, with confirmation and recoverable folder archival. Inherited global skills must not be deletable from project settings.

## Resolved major finding: delete confirmation had a transparent surface

Reproduction: Global Settings → Agent guidance → Skills → a folder skill → Delete. Wait until the alert dialog has opacity 1. Its text overlays the underlying skill cards without an opaque surface, making the destructive confirmation hard to read.

Observed on the initial deletion binary at 1440×900. Screenshot: `tests/results/skill-deletion/confirmation.png`, initial asset `0bb9e21722db2205ef8c400c2fe5bb3dcad7b41f9e976b1faadd1b5524a0b35d.png`. Reported to implementation owner; QA did not change product code. A computed-background assertion was added to prevent a purely functional pass from missing this again.

## Functional coverage

All three browser cases (project switches, project migration, deletion) passed together in 13.5s before the visual assertion was added. Deletion was repeated successfully in 3.9s with settled screenshot capture. Checked global and project folders, inherited no-delete, Cancel, stale supporting-asset edit refusal, Reload settings and retry, reload persistence, text-library deletion, manual command deletion and full archived binary asset equality.

The implementation owner replaced this new confirmation's primitive with the established styled Dialog. The final deletion test passed in 5.6s, including the opaque-background assertion. The final rendered screenshot was inspected: an opaque bordered panel, dark backdrop, readable scope/path/archive explanation and separate Cancel/Delete controls are visible. Confirmation asset: `b59debcc8582d28b25d643b721b217fe32739dc3bd774e8573a9e770d8e3d240.png`.

Global card comparison: before `ecddbc637d930744a7bf232d1cf7aa7a30a8d28f58de788e5093b7ce15ffbc23.png`, after `c7fe444da12876f46444afde89f135bbe4d2a0532cda4732f7ac4cb3d292e24f.png`. Project card comparison: before `31b3418cad7c1f7a5614b23abb9fb26b7b41b5139dfe929bb26f9e9d2f40ef81.png`, after `964da21bb70a869cc1f5550b09581e9c41a62dd89f761b61a3a5d6b9973beb30.png`. Captures have image provenance and no automated vision verdict.

Isolated worktree stack used ports 46740/46741; no owner app was touched. Both ports were verified free after the run. No remaining reproducible defect was found in these bounded deletion flows. Other consumers of the older AlertDialog primitive were not reverified or repaired here; the implementation owner was notified of that separate follow-up risk. Destructive operations were exercised only on disposable fixtures.
