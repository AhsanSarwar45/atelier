# Shared guidance

Settings → Agent guidance manages global instructions, conditional rules, skills,
commands and output styles. Project Settings → Agent guidance supplies project
instructions and project skills, commands and styles. Reusable conditional rules
are managed globally, not in a second project instructions editor.

Instructions and the selected output style enter each provider's session policy.
Skills contribute a short catalogue entry and load on demand through the same
read-only `atelier_skill_read` MCP tool on Claude, Codex and local ACP sessions.
Selecting `/skill:ID` expands the pinned skill before sending the prompt; arguments
are ordinary text, never evaluated shell code. A skill can disable automatic
selection while keeping its explicit shortcut. Operational provider commands
remain native and occupy a separate namespace.

Only one shared output style is selected. A project can inherit the global
selection, choose another style, or explicitly choose no shared style. Styles
govern presentation, not tool permissions or required response schemas.

## Conditions and requirements

The condition builder supports all/any/not groups, file and folder existence,
literal text, regular expressions, filename patterns, declared package
dependencies, JSON pointers, TOML keys, YAML pointers, and the project's Beads
setting. An absent file does not match; invalid or unreadable data is unknown,
including under negation. Requirements are executable names, checked separately
from applicability. A missing executable makes an applicable item unavailable.

Use “In the folder of any matching file” with `**/package.json` to bind a group
to each package in a monorepo. A React dependency in one package and Vitest in a
different package do not satisfy an all-group in a single package. Relative
paths use the current checkout, including worktrees. Scans respect ignore files,
skip dependency/build directories, do not follow symlinks, and have bounded
entry/match counts. Exact file checks refuse symlinks escaping their scope.
No condition runs scripts or shell commands. Requirements reflect the current
local agent environment; remote runtimes would need their own fact transport.

## Inheritance and resources

Stable IDs identify items. Projects customize a global item's conditions,
automatic selection, parameters, or content explicitly; unrelated global
changes remain inherited. Replacements are resolved before conditions, so an
inapplicable replacement cannot unexpectedly revive the global content.
“Reset to global” removes the customization. Removed global sources leave an
explanation and a way to forget their saved customization.
Inside the parameter editor, inherited keys reset to their global values;
project-only keys can be removed. Saving a value identical to the global source
removes that override, so subsequent global edits remain inherited.

Parameters substitute `{{name}}` once without interpreting the result. Supporting
text resources use relative names, such as `references/testing.md`, and are read
with the same MCP tool by passing `id` and `resource`. A bundle name groups related
entries without loading them all. JSON resources hold text; complete skill folders
also support scripts and binary assets. Conditions never execute probes.
Permissions, hooks, credentials and native subagent
execution remain provider settings; importing text does not translate those.

Native-file import copies only the selected instructions, rules, skill, command, or
output-style file. It leaves the original untouched and warns about independent
native loading. Supporting references must be copied into Resources. Review the
old source before retiring it; Atelier never silently deletes native guidance.

## Complete skill folders

Run `atelier tool skills locations` for the global and project `skills` directories.
Put a skill at `skills/<stable-id>/SKILL.md`, preserving its scripts, references,
templates and assets beneath that directory. No provider-specific copy is needed.
The folder ID is lowercase kebab-case; it must not collide with a JSON item in the
same scope. SKILL.md accepts YAML `name` and `description` metadata.
Optional `atelier.json` supplies `when`, `requires`, `parameters` and `automatic`.
Set `automatic: false` for a command; native `disable-model-invocation: true` is
also recognized. Other native frontmatter stays in the file but does not grant
permissions or configure provider runtimes.

Each connection receives a content-addressed copy of the complete folder.
Reading the skill returns its absolute pinned directory; agents read assets and
execute helpers there through their normal filesystem/shell tools and permissions.
Atelier does not execute helpers during discovery or install their dependencies.
Keep generated output outside the pinned directory. Source edits apply on reconnect;
old sessions retain their original supporting files. Parameters apply to the skill
body, not arbitrary script or binary bytes. Internal symlinks are copied as files;
escaping links, cycles, special files and oversized bundles are refused. Limits:
128 KiB instructions, 64 MiB per asset, 256 MiB and 4096 files per skill. Git internals
and Python bytecode caches are omitted. The text reader accepts resources up to
2 MiB; larger or binary resources are used directly through the returned path.

Folder-backed cards show their editable source path. Edit those files directly;
project customizations still use the shared settings editor. To migrate a complete
native skill, copy its whole folder, not just SKILL.md through native-file import.

## Persistence and running chats

Global content is `library.json` in Atelier's data directory. A project's file
lives beside its manifest and moves with project settings between personal and
repository storage. Saves use optimistic revision checks to refuse stale editor
writes and atomic replacement. Files remain human-readable JSON.

Each connection receives an immutable, content-addressed snapshot containing
resolved items, source information, condition evidence, content and resources.
The compact Guidance badge opens a popover showing included/available
items. Skills read during a connection retain their original version even if the
source changes. Settings changes apply on new connections, including resume;
they cannot remove old text from conversation history. Start a fresh chat when
old instructions must no longer remain in context.
The first accepted user turn of each connection also carries the current shared
guidance as a separate context block. This common ACP path refreshes resumed
conversations whose provider retains earlier system/developer instructions.
It does not rewrite the user's stored message, is retried if sending fails, and
is not repeated on subsequent turns of the same connection.
Native slash commands keep their original wire shape; the context block waits
for the next ordinary or shared-skill turn instead of disrupting command parsing.

The read-only CLI uses the same resolver:

```sh
atelier tool skills locations
atelier tool skills locations --project /absolute/project/folder
atelier tool skills list
atelier tool skills read REVISION ID
atelier tool skills read REVISION ID references/testing.md
```

`locations` reports absolute global and active project source paths as JSON,
including repository versus personal storage. It finds the project from the
current folder (or `--project`), handles linked worktrees, and creates no settings
or snapshots. An unregistered folder returns `project: null`; register it before
creating project guidance. Skills and commands can be complete folders or text-only
library items; output styles remain library items.

`atelier tool skills mcp REVISION` serves the same snapshot through stdio MCP.
Read-only review workers receive shared project guidance and can read the pinned
snapshot directly when their restricted tool set has neither MCP nor shell.
Application-owned presentation and Beads guidance are visible built-ins. They
cannot be overridden through the library; enforced workflow and permission rules
remain enforced independently of editable text.

Verification: `tests/e2e/shared-library.spec.ts` drives both editors, reloads,
conditions, local parameters, styles, native import, stale writes, the MCP reader,
and (with `BEADS_E2E_LIVE_PROVIDERS=1`) real Claude and Codex turns. Run through
`scripts/workbench-e2e.sh` with explicit free ports and a worktree-local run folder.
`shared-library-edge-cases.spec.ts` adds editor collisions/reset, stale browser
tabs, condition errors, orphan/conflict handling, and live automatic/manual skill,
nested-resource, output-style, reconnect and two-project isolation cases.
`shared-library-lab.spec.ts` is an opt-in (`BEADS_LIBRARY_LAB=1`) bounded harness
for Chrome DevTools MCP exploration; its readiness wait is not a coverage test.
