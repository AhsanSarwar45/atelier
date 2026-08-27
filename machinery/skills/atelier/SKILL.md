---
name: atelier
description: Use the presentation and interaction capabilities available inside an Atelier-owned chat session, including widgets and visual proof.
---

# Atelier

This session is hosted by Atelier. Use its chat-native presentation features when
they make the result easier to understand.

## Widgets

Use an `atelier-widget` fenced block for structured information that is clearer
than prose. The block must contain exactly one valid JSON object. Every object
requires a `type`; `title` is optional. All labels, values displayed as text,
details, titles, series names, colors, columns, and cells must be non-empty
strings of at most 200 characters.

Use these exact payload shapes:

- `metrics`: `{"type":"metrics","items":[...]}` with 1–6 items. Each item
  requires string `label` and string `value`; optional `detail` is a string and
  optional `trend` is exactly `"up"`, `"down"`, or `"flat"`. Put percentages or
  other explanatory text in `detail`, not `trend`.
- `chart`: `{"type":"chart","chart":"bar"|"line","series":[...],"data":[...]}`.
  Use 1–4 series objects, each with string `name` and optional string `color`—a
  series must not be a bare string. Use 1–30 data objects with string `label`
  and numeric `values`. Each `values` array must have exactly one finite number
  per series, in the same order as `series`.
- `progress`: `{"type":"progress","items":[...]}` with 1–12 items. Each item
  requires string `label` and finite numeric `value`; optional `max` is a finite
  number greater than zero and optional `detail` is a string.
- `timeline`: `{"type":"timeline","items":[...]}` with 1–20 items. Each item
  requires string `label`; optional `detail` is a string and optional `status`
  is exactly `"done"`, `"current"`, or `"next"`.
- `table`: `{"type":"table","columns":[...],"rows":[...]}` with 1–8 string
  columns and at most 30 rows. Every row must contain exactly one non-empty
  string cell per column.
- `video`: `{"type":"video","src":"..."}`. `src` and optional `poster` must
  be an absolute local path or start with `http:`, `https:`, `data:video/`,
  `blob:`, or `file:`.

Valid examples:

```atelier-widget
{"type":"metrics","title":"Health","items":[{"label":"Latency","value":"42 ms","detail":"Improved by 8 ms","trend":"down"}]}
```

```atelier-widget
{"type":"chart","chart":"bar","title":"Requests","series":[{"name":"Web"},{"name":"API"}],"data":[{"label":"Mon","values":[12,8]},{"label":"Tue","values":[18,11]}]}
```

```atelier-widget
{"type":"chart","chart":"line","title":"Response time","series":[{"name":"P95"}],"data":[{"label":"Mon","values":[52]},{"label":"Tue","values":[42]}]}
```

```atelier-widget
{"type":"progress","items":[{"label":"Tests","value":8,"max":10,"detail":"8 of 10"}]}
```

```atelier-widget
{"type":"timeline","items":[{"label":"Built","status":"done"},{"label":"Review","status":"current"},{"label":"Release","status":"next"}]}
```

```atelier-widget
{"type":"table","columns":["Choice","Cost"],"rows":[["A","$2"],["B","$3"]]}
```

```atelier-widget
{"type":"video","title":"Proof","src":"/absolute/path/proof.webm"}
```

Use `video` whenever showing video proof. Never present
video as a file link. Do not use a widget for one fact or a short list.

## Visual proof

For every visual change, capture the relevant screen before editing and again
afterward, then include both in an `atelier-image-compare` block. For a newly added visual
with no meaningful before state, capture and include the finished result as an
ordinary inline image. Do this before handing the work back;
do not wait for the manager to ask.
