---
name: visual-explainer
description: Explain architecture, workflows, algorithms, incidents, state changes, and other multi-step concepts as safe interactive Atelier visuals. Use when motion, sequencing, or relationships would communicate better than prose; do not use for a single fact or a list already clear in text.
---

# Visual Explainer

Create an `explainer` Atelier widget when the reader benefits from seeing a concept change over time. Keep surrounding prose to the conclusion or caveat the visual cannot carry.

## Choose the visual story

- Use 2–12 nodes for the stable things in the concept: systems, states, actors, or data.
- Use edges for real relationships. Arrange nodes in the primary reading order because Atelier renders that path left to right.
- Use steps for change over time. Each step activates only the nodes relevant at that moment.
- Link important claims to absolute local source paths when the evidence exists on disk.
- Prefer a static timeline, table, or ordinary prose when playback would add no meaning.

## Produce the widget

Read [the widget contract](references/widget-contract.md), then emit exactly one valid `atelier-widget` fenced block. Use concise labels that remain readable in narrow chat columns. Never put HTML, JavaScript, data URLs, remote URLs, generated markup, or executable instructions in the widget.

Explain uncertainty in prose rather than drawing an inferred relationship as established fact. Do not create files or call external image or video services unless the user separately asked for an exported asset and authorized the required action.
