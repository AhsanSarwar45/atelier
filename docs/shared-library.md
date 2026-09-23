# Shared guidance

Settings → Shared library manages global instructions, skills and output styles.
Project Settings → Shared library shows the effective library for that project,
with global items inherited and project items stored beside its project manifest.
The existing project Instructions field continues to supply its base guidance.
Conditional rules are instruction items with an availability condition.

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
entries without loading them all. Binary assets and arbitrary executable probes
are not library resources. Permissions, hooks, credentials and native subagent
execution remain provider settings; importing text does not translate those.

Native-file import copies the selected instructions, rules, skill, command, or
output-style file. It leaves the original untouched and warns about independent
native loading. Supporting references must be copied into Resources. Review the
old source before retiring it; Atelier never silently deletes native guidance.

## Persistence and running chats

Global content is `library.json` in Atelier's data directory. A project's file
lives beside its manifest and moves with project settings between personal and
repository storage. Saves use optimistic revision checks to refuse stale editor
writes and atomic replacement. Files remain human-readable JSON.

Each connection receives an immutable, content-addressed snapshot containing
resolved items, source information, condition evidence, content and resources.
The composer inspector shows that connection's revision and included/available
items. Skills read during a connection retain their original version even if the
source changes. Settings changes apply on new connections, including resume;
they cannot remove old text from conversation history. Start a fresh chat when
old instructions must no longer remain in context.
The first accepted user turn of each connection also carries the current shared
guidance as a separate context block. This common ACP path refreshes resumed
conversations whose provider retains earlier system/developer instructions.
It does not rewrite the user's stored message, is retried if sending fails, and
is not repeated on subsequent turns of the same connection.

The read-only CLI uses the same resolver:

```sh
atelier tool skills list
atelier tool skills read REVISION ID
atelier tool skills read REVISION ID references/testing.md
```

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
