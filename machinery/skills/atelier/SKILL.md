---
name: atelier
description: Use Atelier's native presentation tools for validated widgets, animated explainers, durable images, comparisons, and visual proof when they clarify the result.
---

# Atelier

This session is hosted by Atelier. Use its chat-native presentation features when
they make a relationship, change, or comparison easier to understand.

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
- For durable before/after proof, run
  `atelier tool present compare --before PATH --after PATH --before-alt TEXT --after-alt TEXT [--mode side_by_side|wipe]`.

Image commands accept PNG, JPEG, GIF, and WebP up to 25 MiB. They import bytes
into Atelier-owned, content-addressed storage before emitting the widget, so the
visual remains available after reload. Do not invent an asset name or reference
a temporary path in widget JSON.

## Choose the smallest useful presentation

- `metrics` for 2–6 headline values.
- `chart` with `bar` for category comparisons or `line` for trends.
- `progress` for 1–12 bounded completion values.
- `timeline` for 1–20 ordered events that do not need playback.
- `table` for exact side-by-side facts with 1–8 columns and at most 30 rows.
- `video` for video proof. Its `src` is an absolute local path or an `http:`,
  `https:`, `data:video/`, `blob:`, or `file:` URL.
- `explainer` when motion or relationships carry meaning.
- `image` and `image_compare` are produced only by the image commands above.

Do not use a widget for one fact or a short list. Use prose when structure does
not make the answer faster to grasp.

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

For every visual change, capture the relevant screen before editing and again
afterward. Run `atelier tool present compare` with those two project images and
copy its stdout byte-for-byte into the final response. Use `side_by_side` by
default and `wipe` when precise spatial alignment matters.

For a newly added visual with no meaningful before state, capture the finished
result and run `atelier tool present image`. Do this before handing the work
back; do not wait for the manager to ask.
