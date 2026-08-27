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

Use `video` whenever showing video proof. Never present
video as a file link. Do not use a widget for one fact or a short list.

## Visual proof

For every visual change, capture the relevant screen before editing and again
afterward, then include both in an `atelier-image-compare` block. For a newly added visual
with no meaningful before state, capture and include the finished result as an
ordinary inline image. Do this before handing the work back;
do not wait for the manager to ask.
