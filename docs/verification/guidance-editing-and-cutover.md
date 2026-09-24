# Guidance editing and native cutover

Deliverables: bw-yi74.9, bw-yi74.12, bw-yi74.13, bw-yi74.14.

## Exercised paths

- Global folder skill: Edit opens raw parameterized source; save/reload retains
  changed name/body, arbitrary YAML metadata, executable helper and binary bytes.
  External modification rejects a stale save with HTTP 409 and retains the draft.
- Project folder: editing remains project-local; automatic-to-manual conversion
  moves it to Commands. Customizing a global folder does not change its source.
- Claude settings: competing native output-style control removed, link opens the
  shared Output styles tab. Native and ACP startup set only outputStyle=default;
  other provider settings sources remain enabled.
- Global and project Agent files: right-click menu, exact-file confirmation,
  cancel, disk removal, row refresh, cleared editor and recreate affordance.
  Backend tests reject scope escapes and unlink allowed symlinks without following
  their target. UI tests cover failure preservation and unsaved-edit confirmation.
- Real Claude and Codex: both executed global/project Python helpers reading
  binary files; read migrated ai-leaf-cards/morning; executed inspect_card.py
  --help; returned matching font SHA-256; read create-pr, web-qa and
  design-taste-frontend; followed the shared ATELIER_STYLE_PROOF output style.
  Claude's fixture selected a conflicting native style, which did not appear.
- The standup helper read synthetic Claude and Codex transcript fixtures. No
  owner transcripts were scanned; the complete standup workflow was not run.

Browser suites: folder-skill-editing.spec.ts (3 cases), agent-files-delete.spec.ts
(global and project), skill-folders.spec.ts (3 cases, live providers enabled).
All passed in disposable worktree-local stacks, one provider at a time. Chrome
DevTools MCP additionally drove the folder Edit action and style-settings link;
the actual rendered screens were inspected. Screen-check imported the screenshots;
its image judge returned INDETERMINATE, not PASS. That is not counted as visual
worker approval. Before/after files live in tests/results/shared-library and
tests/results/agent-files-delete.

## Actual account migration

Inventory covers Claude System, Azeem, Tapforce and Codex System. See
[the account inventory](account-guidance-inventory.md) for exact source paths and
hashes. Twenty-seven Atelier folders are available with no invalid entries:
18 original skill/command folders plus nine previously omitted account skills.
Sixteen duplicate synced folders match existing migrated files and executable
bits. All 289 staged/copied file hashes were verified.

Global baseline text was merged through the revision-checked library API, the
RTK include expanded, and CodeGraph extracted into a global conditional rule.
The `manager` selection had no available style definition; none was invented.

Recovery archive:
`/home/ahsan/.local/share/atelier/migration-backups/native-guidance-20260924.hvJShP/`.
It contains native-guidance.tar, account-guidance.tar, copied-file manifests,
the previous binary, the previous Codex configuration, and retirement journals.
Seventeen exact native source files/folder trees were moved under `retired/`,
preserving relative paths and symlinks. This includes the empty account baseline
files and the broken report link (whose missing content was not migrated).
Recover by moving a journaled archive path back to its source only after checking
the source has not been recreated; never overwrite a newer file during recovery.

Codex's six provider-managed .system skills remain on disk but are disabled via
documented skills.config entries; a fresh Codex app-server skills/list confirmed
all six have enabled=false. Their content is available through six codex-prefixed
Atelier folders. This avoids fighting regeneration by provider updates.
All unrelated Codex configuration values were compared and preserved. Credentials,
hooks, permissions, plugin caches and plugin registrations were not retired.
Claude synchronization can recreate native copies in the future; this migration
does not disable account sync or claim to prevent future third-party writes.

The previous deployment activated complete folder discovery and the guidance
badge. This change still needs the normal post-landing deployment to expose the
new editor, deletion menu and native-style neutralization in the owner's app.
