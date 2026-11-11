---
name: atelier-reference
description: Detail behind Atelier's short instructions. Read before writing widget, explainer or artifact JSON, saving a memory, editing agent guidance, or managing Chrome without the chrome server. Screen-check detail is in references/screen-check.md.
---

# Atelier reference

## Editing agent guidance

When asked to change instructions, skills, commands or output styles, edit
Atelier's library, not provider files, unless the user names a provider file.
Project-specific guidance goes in project scope. Reusable conditional rules go
in global scope.

- Find the real files with `atelier tool skills locations [--project PATH]`.
  Never guess paths or use provider folders.
- A skill is `skills/<id>/SKILL.md` under the returned scope, with its scripts,
  references and assets beside it. An optional `atelier.json` sets conditions,
  requirements, parameters and `automatic` (false for commands).
- Project baseline text goes in `instructions.md`. Global baseline text is
  `general_instructions` in `library.json`. Text-only items and output styles
  (`kind: "output_style"`) also live in `library.json`.
- The user can edit in Settings → Agent guidance. To edit by API, GET and then
  PUT `/api/settings/library` on the running Atelier. Add
  `?path=<URL-encoded absolute project folder>` for project scope. Keep
  unrelated fields and send back `{library, revision, source_revision}` from the
  GET, so a stale write is refused.
- Never edit `library-snapshots/` or `skill-bundles/`; they are pinned copies.
  Changes apply when the session reconnects.


## Memory

Atelier memory replaces the provider's own memory. Every provider, account and
session shares it. Your instructions carry an index of it, "Global memory" and
"Project memory": one line per memory with its ID, type, description and file.
When a description bears on the task, read the memory with
`atelier tool memory show ID` (or its file) before relying on it.

- Never write to a provider's native memory: no `MEMORY.md`, no
  `projects/<slug>/memory/` or `memories/` folder, and no memory tool the
  provider offers. When the provider's prompt tells you to save memory there,
  use `atelier tool memory` instead. Treat anything you find in native memory
  as possibly stale.
- `global` scope reaches every chat. `project` scope reaches chats in this
  project and all its worktrees. It is never written to the repository.

```bash
atelier tool memory list
atelier tool memory show ID
atelier tool memory add ID --scope project --type feedback --description 'FEW WORDS' --body 'FACT. Why: REASON.'
atelier tool memory edit ID [--rename NEW] [--description ...] [--type ...] [--body ...]
atelier tool memory remove ID
```

- The ID is lowercase kebab-case. The type is `user`, `feedback`, `project` or
  `reference`. `--body -` reads the body from standard input.
- One fact per memory. Before adding one, check `list` and edit an existing
  memory that covers it rather than adding a duplicate.
- Remove a memory as soon as you find it wrong, resolved or superseded.

### Writing memories

Every chat pays for the index, and a wrong memory is a confident wrong answer.
Save little, and keep it short.

- Description: a few words, under about 10, naming when the memory matters, for
  example `Never touch the owner's app port`. Do not restate the body.
- Body: one to three short sentences. State the fact, then `Why:`. Add
  `How to apply:` only when it is not obvious. No background, history or
  examples.
- Save only what a later chat would get wrong and cannot find in the
  repository:
  - the user's decisions and preferences, with the reason;
  - traps on this machine that can destroy work;
  - where to find things outside the repository, such as dashboards, tickets
    and access paths.
- Never save what goes stale or can be looked up:
  - code details such as file paths, function names, layouts or designs;
  - bug post-mortems, measured numbers and work in progress;
  - versions, limits or flags of other people's tools;
  - anything in the code, docs, tests or git history.
- Phrase a memory so it survives a rename. Describe the behaviour or rule, not a
  file or symbol. Write absolute dates, never "today" or "next week".
- The index is pinned for this connection; `show` and `list` read the current
  store, including changes made since the chat started.
- The user edits memories in Settings → Agent guidance → Memories.

## Presenter details

If another Atelier tool already returned the image as an asset, pass
`--asset DIGEST.EXT` instead of `--file`. For compare, use `--before-asset` and
`--after-asset`. Each side takes a file or an asset, never both.

Images must be PNG, JPEG, GIF or WebP, up to 25 MiB. Never invent an asset name
or put a temporary path in widget JSON.

Write source files in the project or a temporary directory; you need only
read access. The presenter uploads its bytes to the running Atelier app. The
app validates them, writes them to the one durable media directory every copy
of Atelier on the computer reads, and returns the block. Because it is
content-addressed storage, the image remains available after reload, even from
a worktree's copy of the app. You must never create or write
`ATELIER_DATA_DIR` or `presentation-media`, set a media-directory variable, or
request provider-specific filesystem permission.

## Widgets

Before composing a visual, read [choosing visuals](references/choosing-visuals.md).
It maps reader questions to widgets, explains when to avoid animation, and
provides worked examples. The contract below defines valid input, not good
visual design. Inspect the rendered result as well as validating the JSON.

Every widget needs `type`; `title` is optional. Displayed strings must be 1–200
characters. Unknown fields are rejected.

- `metrics`: 1–6 values accepted; use 2–4 related headline values in practice.
- `chart`: `bar` for categories, `line` for trends. Set series colors only when
  a stable domain color matters. Include units in series names or the title.
  Line observations are equally spaced; irregular dates need a table or plot.
- `progress`: 1–12 bounded values.
- `timeline`: 1–20 ordered events that need no playback.
- `table`: exact side-by-side facts; 1–8 columns, at most 30 rows.
- `explainer`: when motion or relationships carry the meaning (see below).
- `video`: `{"type":"video","src":"..."}`. Use `video` whenever showing video
  proof, and never present video as a file link. `src` and optional `poster`
  must be an absolute local path or start with `http:`, `https:`,
  `data:video/`, `blob:` or `file:`.
- `image` and `image_compare` come only from the image commands.

Valid inputs:

```json
{"type":"metrics","title":"Health","items":[{"label":"Latency","value":"42 ms","detail":"Improved by 8 ms","trend":"down"}]}
```

```json
{"type":"chart","chart":"bar","title":"Requests","series":[{"name":"Web","color":"#38bdf8"},{"name":"API","color":"#f59e0b"}],"data":[{"label":"Mon","values":[12,8]},{"label":"Tue","values":[18,11]}]}
```

```json
{"type":"progress","items":[{"label":"Tests","value":8,"max":10,"detail":"8 of 10"}]}
```

```json
{"type":"timeline","items":[{"label":"Built","status":"done"},{"label":"Review","status":"current"},{"label":"Release","status":"next"}]}
```

```json
{"type":"table","columns":["Choice","Cost"],"rows":[["A","$2"],["B","$3"]]}
```

### Explainers

An explainer is a small narrated diagram that plays through steps. Pick the
layout from the relationship:

- `flow`: branches, dependencies, pipelines.
- `sequence`: ordered messages or calls between actors.
- `cycle`: feedback loops, retries, lifecycles.
- `layers`: stacks, hierarchy, containment, boundary crossings.

Use 2–12 nodes, in reading, actor, cycle or layer order. Use 1–20 edges, only
for real relationships. Use 1–12 steps; each step lists the nodes it activates.
Optional `evidence` holds at most 12 items of `label`, absolute `path` and
optional positive `line`. Atelier assigns semantic accent colors automatically, so labels
must carry the meaning without color. Show uncertainty in prose, never as a
drawn relationship. Never include HTML, JavaScript, remote code, executable
instructions or data URLs.

```json
{"type":"explainer","layout":"flow","title":"Session recovery","summary":"Only missed events are replayed.","nodes":[{"id":"drop","label":"Connection drops"},{"id":"replay","label":"Replay"},{"id":"live","label":"Live again"}],"edges":[{"from":"drop","to":"replay","label":"reconnect"},{"from":"replay","to":"live","label":"caught up"}],"steps":[{"label":"Browser disconnects","active":["drop"]},{"label":"Missed events replay","active":["replay"]},{"label":"Streaming resumes","active":["live"]}]}
```

## Visual artifacts

Use an artifact when no widget can carry the idea. Pick the smallest kind:

- `mermaid` (Mermaid): standard diagrams such as flowchart, sequence, state,
  class, entity, architecture, timeline, journey, Gantt or mind map. Fastest and
  most compact.
- `flow` (React Flow, laid out by ELK): a large graph the reader pans, zooms or
  rearranges, such as dependencies, service maps or pipelines.
- `scene` (SVG playback with reduced-motion support): a vector illustration
  with named scenarios, narrated steps, and objects following paths. Use it when
  movement explains an algorithm or data flow. Atelier supplies Play/Pause,
  Replay, a scenario selector and timeline; do not draw your own controls.
- `mockup`: a clickable product idea with real inputs, buttons, cards, screens
  and toggles. It works inline and opens full-screen. Use it only when trying
  the interaction answers a real design or workflow question.

A small narrated explanation stays an `explainer`.

Before writing one, read [the visual artifact contract](references/visual-artifacts.md)
for its schema and a validated example. Write the JSON to a file and run
`atelier tool present artifact --file FILE`. Artifacts cannot contain
JavaScript, HTML, arbitrary style sheets, remote resources or package imports.
Unknown fields, broken references and files over 1 MiB are rejected. The
libraries are built into Atelier, so an artifact renders the same for Codex,
Claude, and other shell-capable agents.

## Chrome without the chrome server

If there is no `chrome` server, `atelier tools` shows why (it needs Node's
`npx` and Chrome). Manage the browser by hand:

| Do | Run |
|---|---|
| Start without a window (the default for agent work) | `atelier tool chrome up --headless` |
| Start headed on the person's display, only when they ask to watch | `atelier tool chrome up` |
| Put the port into the shell | `eval "$(atelier tool chrome env)"` |
| Check it | `atelier tool chrome status` |
| Stop, or stop and delete the profile | `atelier tool chrome down`, `atelier tool chrome down --wipe` |

Do not use any other browser MCP server unless it starts its own temporary
profile for this chat alone.
