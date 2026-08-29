# Visual artifact contract

Create exactly one JSON object with `version: 1`, a `kind`, and a concise
`title`. Optional `description` may explain what to look for. Save it, run
`atelier tool present artifact --file FILE`, and copy stdout unchanged.

## Mermaid

Use any syntax supported by Mermaid when a standard diagram is sufficient.

```json
{"version":1,"kind":"mermaid","title":"Request lifecycle","source":"sequenceDiagram\n  participant UI\n  participant API\n  participant Worker\n  UI->>API: Submit\n  API->>Worker: Queue\n  Worker-->>UI: Stream result"}
```

`source` is non-empty and at most 50,000 characters. Atelier runs Mermaid in
strict security mode.

## Interactive flow canvas

Use 2–100 uniquely identified nodes and at most 200 edges. Edge endpoints must
name existing nodes. `direction` is `RIGHT` or `DOWN`; `editable` controls node
dragging and defaults to true. ELK calculates initial positions.

```json
{"version":1,"kind":"flow","title":"Release pipeline","direction":"RIGHT","editable":true,"nodes":[{"id":"source","label":"Source","detail":"Reviewed change","color":"#38bdf8"},{"id":"checks","label":"Checks","detail":"Build and test","color":"#f59e0b"},{"id":"release","label":"Release","color":"#22c55e"}],"edges":[{"id":"source-checks","from":"source","to":"checks","label":"commit","animated":true},{"id":"checks-release","from":"checks","to":"release","label":"green","animated":true}]}
```

## Custom animated vector scene

`viewBox` is four finite numbers. Supply 1–200 primitives: `rect`, `circle`,
`ellipse`, `line`, `path`, `polygon`, or `text`. Each needs a unique `id` and
may use the matching vector attributes (`x`, `y`, `width`, `height`, `cx`,
`cy`, `r`, `rx`, `ry`, `x1`, `y1`, `x2`, `y2`, `d`, `points`, `text`, `fill`,
`stroke`, `strokeWidth`).

Supply 1–30 named states. Each state's changes target existing element IDs and
may animate `opacity`, `x`, `y`, `scale`, `rotate`, and `pathLength`. `duration`
is 0–30 seconds. Keep important meaning in labels as well as color or motion.

```json
{"version":1,"kind":"scene","title":"Packet crosses the boundary","viewBox":[0,0,640,260],"elements":[{"id":"client","type":"rect","x":30,"y":70,"width":150,"height":110,"rx":18,"fill":"#0f2740","stroke":"#38bdf8","strokeWidth":3},{"id":"server","type":"rect","x":460,"y":70,"width":150,"height":110,"rx":18,"fill":"#122d20","stroke":"#22c55e","strokeWidth":3},{"id":"path","type":"path","d":"M180 125 C280 30 360 220 460 125","fill":"none","stroke":"#f59e0b","strokeWidth":5},{"id":"packet","type":"circle","cx":180,"cy":125,"r":14,"fill":"#f59e0b"},{"id":"label","type":"text","x":245,"y":235,"text":"Validated request","fill":"#e5e7eb"}],"states":[{"id":"request","label":"Request leaves client","duration":0.7,"changes":[{"element":"packet","x":0,"scale":1},{"element":"path","pathLength":0.2}]},{"id":"validated","label":"Boundary validates it","duration":1.1,"changes":[{"element":"packet","x":215,"scale":1.4},{"element":"path","pathLength":0.65}]},{"id":"delivered","label":"Server receives it","duration":0.8,"changes":[{"element":"packet","x":430,"scale":1},{"element":"path","pathLength":1}]}]}
```

## Interactive mockup

Define 1–20 screens and name `initialScreen`. An optional viewport accepts a
width from 320–1920 and height from 240–1200. Components may nest to five
levels and use `heading`, `text`, `button`, `input`, `badge`, `card`, `stack`,
or `divider`. Use `tone` values `primary`, `neutral`, `success`, or `warning`.

Buttons may navigate to a screen or toggle another component by ID. Inputs are
keyboard-editable. Build a realistic happy path and the important alternate
state, but do not imitate a production screen merely as decoration.

```json
{"version":1,"kind":"mockup","title":"Invite flow","initialScreen":"form","viewport":{"width":1200,"height":760},"screens":[{"id":"form","title":"Invite teammate","components":[{"id":"panel","type":"card","text":"Invite teammate","tone":"neutral","children":[{"id":"intro","type":"text","text":"They will receive access to this project."},{"id":"email","type":"input","label":"Email","placeholder":"teammate@example.com"},{"id":"send","type":"button","text":"Send invite","tone":"primary","action":{"type":"navigate","screen":"sent"}}]}]},{"id":"sent","title":"Invitation sent","components":[{"id":"success","type":"card","tone":"success","children":[{"id":"title","type":"heading","text":"Invitation sent"},{"id":"detail","type":"text","text":"The teammate can now join the project."},{"id":"again","type":"button","text":"Invite another","tone":"neutral","action":{"type":"navigate","screen":"form"}}]}]}]}
```
