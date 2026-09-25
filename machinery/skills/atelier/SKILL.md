---
name: atelier
description: Use Atelier's native presentation tools for validated widgets, library-powered diagrams, custom animated vector scenes, interactive mockups, durable media, and visual proof when they clarify the result.
---

# Atelier

This session runs inside Atelier. Its presenter shows widgets, images and
diagrams in the chat. Use them when they make a relationship, change or
comparison faster to understand. Otherwise write prose. Do not use a widget for
one fact or a short list.

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

## Presenter commands

Never hand-author an `atelier-widget` or `atelier-image-compare` fence. Run the
Atelier presenter and copy its stdout into your reply byte-for-byte. It
validates the input and prints the canonical block.

| Output | Command |
|---|---|
| Widget | `atelier tool present widget`, one JSON object on stdin or `--input FILE` |
| Image | `atelier tool present image --file PATH --alt TEXT [--caption TEXT]` |
| Before and after | `atelier tool present compare --before PATH --after PATH --before-alt TEXT --after-alt TEXT [--mode side_by_side\|wipe]` |
| Diagram, scene or mockup | `atelier tool present artifact --file FILE` |

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

Every widget needs `type`; `title` is optional. Displayed strings must be 1–200
characters. Unknown fields are rejected.

- `metrics`: 2–6 headline values.
- `chart`: `bar` for categories, `line` for trends. Set series colors only when
  a stable domain color matters.
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
{"type":"explainer","layout":"sequence","title":"Session recovery","summary":"Only missed events are replayed.","nodes":[{"id":"drop","label":"Connection drops"},{"id":"replay","label":"Replay"},{"id":"live","label":"Live again"}],"edges":[{"from":"drop","to":"replay","label":"reconnect"},{"from":"replay","to":"live","label":"caught up"}],"steps":[{"label":"Browser disconnects","active":["drop"]},{"label":"Missed events replay","active":["replay"]},{"label":"Streaming resumes","active":["live"]}]}
```

## Visual artifacts

Use an artifact when no widget can carry the idea. Pick the smallest kind:

- `mermaid` (Mermaid): standard diagrams such as flowchart, sequence, state,
  class, entity, architecture, timeline, journey, Gantt or mind map. Fastest and
  most compact.
- `flow` (React Flow, laid out by ELK): a large graph the reader pans, zooms or
  rearranges, such as dependencies, service maps or pipelines.
- `scene` (Motion): a custom animated vector illustration that moves between
  named states, such as an algorithm, data movement or a simulation.
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

## Browser

All Chrome work goes through Atelier's `chrome` MCP server: opening, checking,
clicking through, testing, QA, console and network checks, and screenshots.
Atelier gives it to every chat. It is the Chrome DevTools MCP server, connected
only to this worktree's private Chrome, which has its own profile and port.
Chrome starts headless on the first browser tool call, so no window opens or
takes focus; screenshots, snapshots and input all work the same. It stops when
the last chat using it ends. When the person asks to watch, run
`atelier tool chrome up` first: the server then uses that headed Chrome.

- Give each simulated user their own `isolatedContext` name in `new_page`,
  so their logins never overwrite each other. Each name opens its own window
  when Chrome is headed.
  Pick one short name per user (`admin`, `learner-1`) and reuse it for every
  page that user opens; never make a second name for the same user.
- Open pages with `background: true`, so a headed Chrome's windows do not jump
  in front of the person's work.
- Clean up as you go. Close each page with `close_page` as soon as you are done
  with it, and run `atelier tool chrome down` when the browser work is
  finished. Chrome otherwise stays running until the chat ends.
- For a script or an end-to-end run, use the same Chrome over CDP:
  `eval "$(atelier tool chrome env)"`, then Playwright
  `chromium.connectOverCDP(process.env.CDP_URL)` with one `browser.newContext()`
  per user.
- If there is no `chrome` server, `atelier tools` shows why (it needs Node's
  `npx` and Chrome). Manage the browser by hand:

| Do | Run |
|---|---|
| Start without a window (the default for agent work) | `atelier tool chrome up --headless` |
| Start headed on the person's display, only when they ask to watch | `atelier tool chrome up` |
| Put the port into the shell | `eval "$(atelier tool chrome env)"` |
| Check it | `atelier tool chrome status` |
| Stop, or stop and delete the profile | `atelier tool chrome down`, `atelier tool chrome down --wipe` |

Never stop a browser by name (`pkill`, `killall`), never pick a fixed port or a
shared profile, and never attach to a DevTools port or profile you did not get
from `atelier tool chrome`. Do not use any other browser MCP server unless it
starts its own temporary profile for this chat alone.

## Visual proof

For every visual change, capture the relevant screen before editing and again
afterward. Show both with `atelier tool present compare`: `side_by_side` by
default, `wipe` when exact alignment matters. For a newly added visual with no
meaningful before state, capture the result and show it with
`atelier tool present image`. Do this before handing the work back; do not wait
for the manager to ask.

Pick the route by how the screen is reached:

- Reached by clicking, typing or signing in as one or more users: drive it
  with the `chrome` server, save it with `take_screenshot` and a `filePath`,
  then show it with `present image --file` or
  `present compare --before ... --after ...`. To have it judged, pass the file
  to `screen-check check --type image`.
- Reached by a URL or a declarative recipe, and it needs a settled, judged
  frame: `atelier tool screen-check`. It starts its own throwaway headless
  Chrome for each capture and deletes it afterwards, so its frames never carry
  your logins or another run's state. Do not point it at `atelier tool chrome`.

Screen-check (`--help` for syntax) navigates only the URL you give. It never
starts, stops, installs or reconfigures the app; the app must already be
running at that URL. If you are unsure which screen-check route fits, run
`atelier tool screen-check plan [--target URL|FILE] [--window-id ID] [--recipe FILE]`
and follow the command it returns; do not widen the capture.

| Need | Use |
|---|---|
| Page already in the right state | `--type web --target URL` |
| Login, cookies, headers, clicks, typing, navigation, uploads or waits | `--recipe FILE` |
| Native app, simulator or remote desktop | one window: `--type window --window-id ID` |
| A screenshot from the `chrome` server or another authorized tool | `--type image --target FILE` |
| Before and after already captured | `compare --before FILE --after FILE` |

Commands:

- Capture only: `atelier tool screen-check capture --type web --target URL [--viewport 1280x800] [--theme light|dark|system]`,
  or `capture --type image --target FILE`.
- Capture and judge one frame: `atelier tool screen-check check --type web|image --target URL|FILE --expect TEXT [--provider claude|codex]`.
- Judge a change: `atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]`.
  For live pages, prefer `--before-recipe BEFORE.json --after-recipe AFTER.json`
  with the same URL, device or viewport, locale, timezone, theme and capture
  settings. Different settings, final URLs or image sizes are refused.
- Windows: list them with `atelier tool screen-check windows`. Bring the one
  window fully to the front, uncovered, then run
  `capture|check --type window --window-id ID`. Hidden, minimized, background or
  unstable windows are refused. Never guess a window, capture a whole display,
  dismiss privacy prompts or change capture permissions.
- `--type auto` only for an unambiguous HTTP(S) URL or an uploaded image.

Pass each result's `captures[].asset` to `present image --asset` or
`present compare --before-asset ... --after-asset ...`.

Give `--expect` one observable expectation. `PASS` means it is visibly met,
`FAIL` means it is visibly contradicted, and `INDETERMINATE` means the pixels
cannot settle it. A capture or permission error is a tool failure, not a failed
check. Accept the verdict; do not reopen the images to judge them again.

### Browser recipes

Top-level fields: `url`, `timeout_ms`, `device` or `viewport`
(`{width, height}`), `locale`, `timezone`, `theme`, `auth`, `actions`,
`settle`, `capture`. Anything else is rejected. Example:

```json
{
  "url": "http://127.0.0.1:4173/login",
  "device": "mobile",
  "auth": { "storage_state": "state.json" },
  "actions": [
    { "action": "fill", "selector": "#email", "value": "person@example.test" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait_for_text", "text": "Dashboard" }
  ],
  "settle": { "selector": "[data-testid=ready]", "text": "Complete" },
  "capture": { "mode": "element", "selector": "main" }
}
```

- Put the recipe, storage state and upload files in one private temporary
  directory; paths outside it are refused. For compare, keep each recipe's files
  beside that recipe.
- `auth` takes `storage_state`, `headers` or `http_credentials`. Keep secrets in
  these files, never in a shell argument or your reply. Results never repeat
  typed values, credentials, headers, cookies or storage.
- Actions: `goto`, `click`, `fill`, `type`, `press`, `select`, `check`,
  `uncheck`, `hover`, `upload`, `wait`, `wait_for`, `wait_for_text`. Only these
  declarative actions run, never scripts. Use selectors from accessible names or
  stable test IDs, not generated classes or coordinates.
- Every web capture waits for load, network quiet, decoded fonts and images,
  stopped motion and caret, and stable layout, then needs two identical frames.
  If any phase fails, the tool fails; it never returns an unstable frame.
  `timeout_ms` (default 30000) bounds the whole run. `settle.selector` and
  `settle.text` wait for app readiness. Change `settle.network_idle_ms`,
  `settle.layout_stable_ms` or `settle.matching_frames` only when the defaults
  cannot work. Set `settle.disable_animations` to `false` only when the
  animation is the evidence.
- `capture.mode`: `viewport` (default), `full_page`, `element` with one stable
  `selector`, or `clip` with `capture.clip` set to `{x, y, width, height}`:
  `x` and `y` at least 0, `width` and `height` at least 1.
- `device` is `desktop`, `tablet` or `mobile` and fixes viewport, scale and
  touch. Do not combine it with `viewport`. `locale` and `timezone` default to
  `en-US` and `UTC`; set them when the state depends on them.

### Reading results

- Browser captures report the final URL, redirects, status, console and
  network failure counts, visible DOM text and an accessibility outline. `check` and `compare` report
  `visible_text.source=vision`; never present vision text as DOM text or merge
  the two.
- Image and window captures have no text until a check runs
  (`vision-required`).
- A PNG compare reports changed pixels, a difference ratio and a diff asset. A
  non-PNG upload or a size mismatch is still judged but is marked objectively
  unaligned.
