# Complete skill folders and guidance badge

Work: bw-yi74.10 and bw-yi74.11. Migration cutover: bw-yi74.9.

## Exercised paths

- Folder integration tests: binary bytes, executable helper, 200 KB resource,
  nested references, traversal rejection, internal/escaping links and cycles,
  session pinning after source edits, project conditions, manual invocation,
  project content customization, stale source revision, duplicate IDs and
  moving project settings with its complete folder tree.
- Independent review identified that malformed folders could block unrelated
  chats. The fix isolates malformed names/frontmatter/settings, broken links
  and pinning failures as invalid rows with source paths and diagnostics. Valid
  skills remain usable and library saves remain possible. Live cases also keep
  a malformed folder present while starting both providers and using valid ones.
- `agent-guidance.spec.ts` chat cases: both provider layouts; compact badge by
  default, grouped popover, hidden diagnostics, Escape and focus return, 390px
  layout without horizontal overflow. Before and after PNGs in
  `tests/results/shared-library/`.
- `skill-folders.spec.ts`, real Claude and Codex, isolated credential copies,
  one worker: discovered global and personal-project folders using the new
  locations command, read both via shared skill access, executed Python helpers
  reading binary assets, returned `GLOBAL:00ff1180` and `LOCAL:00ff1180`.
- Chrome DevTools MCP: opened global folder card, inspected its source path;
  opened Active guidance in the real Codex chat and read its screenshot. It
  contained the 19 on-demand skills and the successful helper results.

## Actual native collection, staged only

Seventeen source folders (Claude synced/user skills, Codex system/user skills,
and the common composio skill) resolved successfully. All 275 non-cache files,
4,157,093 bytes, including 76 scripts and six binary assets, matched the pinned
copies byte-for-byte. The two skill-creator implementations have distinct IDs;
Codex-managed copies retain a `codex-` ID prefix. The shared external-review
symlink was deduplicated. A broken native report symlink has no source to import.

With these copied folders present, both real providers read `ai-leaf-cards` and
`morning`, executed `scripts/inspect_card.py --help`, and hashed the bundled font:

    usage: inspect_card.py [-h] --out OUT card
    3a1de7711d147bad4422825045f87597fd77cca72e7c96d3b0a81735d00dda82

This proves discovery and actual filesystem use, not every possible operation
of every migrated skill. Provider-native tools, hooks, models and permissions
are not translated by moving folders. Existing environment-specific paths and
dependencies still need their own runtime support.

The standup command and helper are also staged; its helper path is relative to
Atelier's returned skill directory and it is marked manual-only. Its complete
standup workflow has not been executed as a migration test (it fetches repository
history and writes a report). Native originals have not been retired.

The installed owner app cannot discover these folders until it runs the new
binary. Do not switch off native sources before that cutover, and do not restart
the owner's app under the isolated-test workflow. Provider-managed system skills
may be recreated by provider upgrades; moving them is not a durable disablement.
