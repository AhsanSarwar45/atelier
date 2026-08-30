---
name: atelier
description: Use Atelier's native presentation tools for validated widgets, library-powered diagrams, custom animated vector scenes, interactive mockups, durable media, and visual proof when they clarify the result.
---

# Atelier

This session is hosted by Atelier. Use its chat-native presentation features when
they make a relationship, change, or comparison easier to understand.

## Live checklist

A checklist is a view of an epic, not a second task list maintained by the
agent. Show one only when the work has a Beads epic: pass that epic's ID as the
single item in the provider checklist. Atelier replaces it with the epic's
direct children and reads every title and status from Beads, so never copy the
children into the checklist or update their checklist statuses by hand. For a
standalone ticket or work with no epic, do not publish a checklist. The agent's
only ongoing responsibility is keeping track of the ticket it is working on.

## Always use the presenter

Never hand-author an `atelier-widget` or `atelier-image-compare` fence. Give the
bundled Atelier presenter structured input, then copy its stdout into the response
byte-for-byte. The command validates the payload and returns canonical transcript
syntax, so Codex and Claude use the same durable format and invalid widgets fail
before they reach chat.

- For a structured or animated widget, pass one JSON object on stdin to
  `atelier tool present widget`. Use `--input FILE` instead when the JSON already
  exists in a file.
- For one durable image, run
  `atelier tool present image --file PATH --alt TEXT [--caption TEXT]`.
  When another Atelier tool already returned a content-addressed asset, use
  `atelier tool present image --asset DIGEST.EXT --alt TEXT [--caption TEXT]`
  without opening or uploading the image again.
- For durable before/after proof, run
  `atelier tool present compare --before PATH --after PATH --before-alt TEXT --after-alt TEXT [--mode side_by_side|wipe]`.
  Existing evidence uses `--before-asset DIGEST.EXT --after-asset DIGEST.EXT`
  with the same alt and mode options. Each side must use either its file option
  or its asset option, never both.
- For a rich diagram, custom animated scene, or interactive mockup, create a
  visual artifact JSON file, then run `atelier tool present artifact --file FILE`.

Image commands accept PNG, JPEG, GIF, and WebP up to 25 MiB. They import bytes
into Atelier-owned, content-addressed storage before emitting the widget, so the
visual remains available after reload. Do not invent an asset name or reference
a temporary path in widget JSON.

Create source images and artifact JSON in the project or a temporary directory
the agent can already write, then give that path to the presenter. The command
reads the temporary file and uploads its bytes to the running Atelier app; the
app validates them, writes its own durable media directory, and returns the
canonical transcript block. The agent must never create or write
`ATELIER_DATA_DIR` or `presentation-media`, set a media-directory environment
variable, or request provider-specific filesystem permission for this flow.
Codex, Claude, and every other shell-capable provider use the same command and
need only read access to the source file.

## Choose the smallest useful presentation

- `metrics` for 2–6 headline values.
- `chart` with `bar` for category comparisons or `line` for trends.
- `progress` for 1–12 bounded completion values.
- `timeline` for 1–20 ordered events that do not need playback.
- `table` for exact side-by-side facts with 1–8 columns and at most 30 rows.
- `video`: `{"type":"video","src":"..."}`. Use `video` whenever showing video proof.
  Its `src` and optional `poster` must be an absolute local path or start with `http:`, `https:`,
  `data:video/`, `blob:`, or `file:`.
- `explainer` when motion or relationships carry meaning.
- `image` and `image_compare` are produced only by the image commands above.

Never present
video as a file link.

Do not use a widget for one fact or a short list. Use prose when structure does
not make the answer faster to grasp.

## Rich visual artifacts

Use a visual artifact when a fixed widget cannot carry the idea. Choose the
smallest runtime that matches what the reader needs:

- `mermaid` uses Mermaid for a conventional flowchart, sequence, state, class, entity,
  architecture, timeline, journey, Gantt, mind map, or other standard technical
  diagram. This is the fastest and most compact choice when custom placement or
  motion adds no meaning.
- `flow` for a large relationship map the reader should pan, zoom, inspect, or
  rearrange. React Flow renders the canvas and ELK lays it out automatically;
  use it for dependency graphs, service maps, pipelines, and node-based systems.
- `scene` for a bespoke animated illustration whose shapes, paths, movement,
  emphasis, or transitions explain the concept. Motion animates safe structured
  vector primitives between named states. Use it for algorithms, spatial
  explanations, data movement, transformations, and simulations.
- `mockup` for a product idea the reader must click through. Use real inputs,
  buttons, cards, navigation between screens, and toggled states. Every mockup
  works inline and can open full-screen.

Keep using `explainer` for a small 2–12-node narrated explanation; choose `flow`
when the canvas itself must be explored, and `scene` when the visual cannot be
expressed as nodes and edges. Do not turn a result into a mockup unless trying
the interaction would answer a real design or workflow question.

Before creating one of these artifacts, read
[the visual artifact contract](references/visual-artifacts.md) for its exact
schema and a validated example. Write the JSON to a project file, run the
artifact presenter, and copy stdout byte-for-byte. The presenter rejects
unknown fields, executable markup, broken references, and files over 1 MiB,
then stores canonical content under a durable hash.

Artifacts cannot contain JavaScript, HTML, arbitrary style sheets, remote
resources, or package imports. Their libraries are built into Atelier, which is
what makes the same artifact safe and identical across Codex, Claude, and other
shell-capable agents.

Every widget object requires `type`; `title` is optional. All displayed strings
must be non-empty and at most 200 characters. The presenter rejects unknown
fields. These are valid inputs to `atelier tool present widget`:

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

## Animated explainers

Use an `explainer` when the reader benefits from seeing a concept change over
time. Choose the layout from the relationship:

- `flow` for branches, dependencies, pipelines, and network relationships.
- `sequence` for ordered messages or calls between actors.
- `cycle` for feedback loops, retries, and recurring lifecycles.
- `layers` for architecture stacks, hierarchy, containment, and boundary crossings.

Use 2–12 nodes for stable systems, states, actors, or data. Use 1–20 edges only
for real relationships. Use 1–12 steps for change over time; each step activates
only the relevant nodes and playback animates the transition. Node order is the
reading, actor, cycle, or layer order. Optional evidence contains at most 12
absolute local paths and positive line numbers.

```json
{"type":"explainer","layout":"sequence","title":"Session recovery","summary":"Only missed events are replayed.","nodes":[{"id":"drop","label":"Connection drops"},{"id":"replay","label":"Replay"},{"id":"live","label":"Live again"}],"edges":[{"from":"drop","to":"replay","label":"reconnect"},{"from":"replay","to":"live","label":"caught up"}],"steps":[{"label":"Browser disconnects","active":["drop"]},{"label":"Missed events replay","active":["replay"]},{"label":"Streaming resumes","active":["live"]}]}
```

Atelier assigns semantic accent colors automatically to nodes, paths, cycles,
layers, and active steps. Treat color as reinforcement: labels and structure
must still communicate the meaning without it. For charts, set series colors
only when a stable domain color matters; otherwise let the UI choose.

Explain uncertainty in prose rather than drawing an inferred relationship as
fact. Never place HTML, JavaScript, remote code, executable instructions, or
data URLs in an explainer.

## Visual proof

Use `atelier tool screen-check` to acquire visual evidence. It is a real
capture tool, not a prompt shortcut: web targets use an isolated headless
Chrome/Chromium profile over the DevTools protocol, named windows use the
platform capture adapter, and existing images are uploaded through the running
Atelier app. The app stores only content-addressed evidence and returns asset
references. Run `atelier tool screen-check --help` for concise syntax or
`atelier tool screen-check --schema` for its machine-readable contract.

Ask the command to choose when the route is unclear:
`atelier tool screen-check plan [--target URL|FILE] [--window-id ID] [--recipe FILE]`.
Follow the returned next command; do not improvise a broader capture.

| Need | Use |
|---|---|
| Public page already in the right state | `--type web --target URL` |
| Login, cookies, headers, clicks, typing, navigation, uploads, or explicit waits | `--recipe FILE` |
| Native app, simulator, remote desktop, or an authenticated browser already open | Discover and select one window ID, then `--type window --window-id ID` |
| Pixels prepared by another authorized tool | `--type image --target FILE` |
| Before and after already captured | `compare --before FILE --after FILE` |

Browser recipes run in a fresh profile and allow only bounded declarative
actions—never arbitrary script execution. Authentication must be explicit via
recipe-local storage state, headers, or HTTP credentials. Put the recipe,
storage state, and upload files in one private temporary directory; references
outside that directory are refused. The result never repeats typed values,
credentials, headers, cookies, or storage contents.

```json
{
  "url": "http://127.0.0.1:4173/login",
  "auth": { "storage_state": "state.json" },
  "actions": [
    { "action": "fill", "selector": "#email", "value": "person@example.test" },
    { "action": "fill", "selector": "#password", "value": "secret" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait_for_text", "text": "Dashboard" }
  ]
}
```

Supported actions are `goto`, `click`, `fill`, `type`, `press`, `select`,
`check`, `uncheck`, `hover`, `upload`, `wait`, `wait_for`, and
`wait_for_text`. Use selectors tied to accessible names or stable test IDs;
avoid generated classes and screen coordinates. Keep secrets in a temporary
recipe or storage-state file, never in a shell argument or final response.

- Capture without judgment:
  `atelier tool screen-check capture --type web --target URL [--viewport 1280x800] [--theme light|dark|system]`
  or `capture --type image --target FILE`.
- Capture and judge one frame:
  `atelier tool screen-check check --type web|image --target URL|FILE --expect TEXT [--provider claude|codex]`.
- Judge a change:
  `atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]`.
- Capture one OS window only with
  `atelier tool screen-check windows`, bring the intended window fully to the
  foreground without covering it, then run
  `capture|check --type window --window-id ID`. The tool preflights permission,
  refuses hidden, minimized, non-foreground, missing, or unstable windows, and
  requires two identical frames. Never infer a window, capture a whole display,
  dismiss privacy prompts, or change screen-capture permissions.
- Use `--type auto` only when `--target` is an unambiguous HTTP(S) URL or an
  uploaded image. Otherwise name the type.

State one observable expectation. The isolated visual worker returns `PASS`
only for visible satisfaction, `FAIL` only for a visible contradiction, and
`INDETERMINATE` when pixels cannot settle the claim. Treat capture and
permission errors as tool failures, not failed product assertions. Do not ask
the parent agent to open or reinterpret returned images. Reuse each returned
`captures[].asset` with `atelier tool present image --asset ...` or
`present compare --before-asset ... --after-asset ...`.

Screen-check may navigate the exact web URL requested, but must not start,
restart, stop, install, or reconfigure the target application. Web capture uses
a fresh browser profile and does not inherit the user's cookies or browser
session. Use a bounded browser recipe for authentication and interaction; use
an uploaded image only when another authorized tool already prepared the exact
pixels that need inspection.

For every visual change, capture the relevant screen before editing and again
afterward. Run `atelier tool present compare` with those two project images and
copy its stdout byte-for-byte into the final response. Use `side_by_side` by
default and `wipe` when precise spatial alignment matters.

For a newly added visual with no meaningful before state, capture the finished
result and run `atelier tool present image`. Do this before handing the work
back; do not wait for the manager to ask.
