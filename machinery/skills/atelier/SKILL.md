---
name: atelier
description: Use the presentation and interaction capabilities available inside an Atelier-owned chat session, including widgets and visual proof.
---

# Atelier

This session is hosted by Atelier. Use its chat-native presentation features when
they make the result easier to understand.

## Widgets

Use an `atelier-widget` fenced block for structured information that is clearer
than prose. The block contains one JSON object with one of these shapes:

- `metrics`: `items` with `label`, `value`, and optional `detail` or `trend`.
- `chart`: `chart` (`bar` or `line`), `series`, and `data` whose numeric `values`
  follow series order.
- `progress`: `items` with `label`, numeric `value`, and optional `max` or `detail`.
- `timeline`: `items` with `label`, optional `detail`, and optional `status`
  (`done`, `current`, or `next`).
- `table`: `columns` and equally sized string `rows`.
- `video`: absolute local or HTTP(S) `src`, with optional `title` or `poster`.

Use `video` whenever showing video proof. Never present
video as a file link. Do not use a widget for one fact or a short list.

## Visual proof

For every visual change, capture the relevant screen before editing and again
afterward, then include both in an `atelier-image-compare` block. For a newly added visual
with no meaningful before state, capture and include the finished result as an
ordinary inline image. Do this before handing the work back;
do not wait for the manager to ask.
