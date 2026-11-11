# Visual artifact contract

Create exactly one JSON object with `version: 1`, a `kind`, and a concise
`title`. Optional `description` may explain what to look for. Save it and run
`atelier tool present artifact --file FILE`. The chat shows it where the
command ran; do not paste the output.

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

Use a scene when following an object or a geometric change explains the idea.
Use a bar/line chart for measured values, a Mermaid diagram for a static
relationship, and an explainer for a narrated overview without moving objects.

Supply 1–30 uniquely named `states`. Each has `id`, `label`, `changes`, optional
`detail` (up to 1,000 characters), and `duration` (0–30 seconds, default 1.5).
Duration is the transition **into** that state; the first state is immediate.
Changes target element IDs and may set `opacity`, translation `x`/`y`, `scale`,
`rotate`, and `pathLength`. Unchanged properties carry forward within a scenario.
A scenario starts from defaults: x/y/rotate 0, opacity/scale/pathLength 1.

For motion along a route, create a `path` element with SVG `d`, then set both
`along` (that path's ID) and `progress` (0–1) in the moving object's change.
Draw moving objects around local origin (0,0): a circle uses cx/cy 0. Progress
uses distance along the entire path, including curves. The route is sampled in
its original viewBox coordinates; keep its geometry static. Do not combine
along/progress with x/y. A later x/y change leaves the route. Switching to a
different route starts at its beginning: join routes at the same coordinate
or start a new scenario to avoid an unexplained jump.

Optional `scenarios` (1–12) contains unique `id`, human-readable `label`, and
`steps` (1–30 existing state IDs in playback order). Without it, all states form
one timeline. Scenarios can reuse states. They reset independently, so no
position or styling leaks from a previously viewed scenario.

Atelier supplies the scenario selector, Play/Pause, Replay, previous/next step,
and a timeline slider. Playback starts paused, stops at the end, and never loops.
Scrubbing pauses and updates immediately; arrow keys on the slider select steps.
Reduced motion disables automatic playback; manual steps remain available.
Do not invent buttons in the SVG or flatten scenario names into step labels.

Before presenting: name what moves, label the route endpoints, state one
conclusion in the title, and explain each step in everyday language. The
initial frame and every paused step must make sense without watching motion.
Avoid flashing or using color alone to convey meaning. These examples use
illustrative routes, not measured timings.

### Compare two scenarios

```json
{"version":1,"kind":"scene","title":"A cache hit skips the database","description":"The white dot represents one request. Choose a scenario, then play or step through its route.","viewBox":[0,0,640,270],"elements":[{"id":"hit","type":"path","d":"M70 100 L270 100 L550 100","fill":"none","stroke":"#34d399","strokeWidth":3},{"id":"miss","type":"path","d":"M70 100 L270 100 L400 205 L550 100","fill":"none","stroke":"#fbbf24","strokeWidth":3},{"id":"client","type":"text","x":30,"y":65,"text":"Client","fill":"#cbd5e1"},{"id":"cache","type":"text","x":235,"y":65,"text":"Cache","fill":"#cbd5e1"},{"id":"database","type":"text","x":355,"y":240,"text":"Database","fill":"#cbd5e1"},{"id":"response","type":"text","x":510,"y":65,"text":"Response","fill":"#cbd5e1"},{"id":"skip","type":"text","x":345,"y":80,"text":"Saved result","fill":"#cbd5e1"},{"id":"legend","type":"text","x":25,"y":25,"text":"White dot = one request","fill":"#cbd5e1"},{"id":"request","type":"circle","cx":0,"cy":0,"r":9,"fill":"#ffffff","stroke":"#0f172a","strokeWidth":2}],"states":[{"id":"hit-start","label":"Request starts at the client","detail":"A usable response is already in the cache.","duration":2,"changes":[{"element":"request","along":"hit","progress":0}]},{"id":"hit-cache","label":"Check the cache","detail":"The cache contains the requested result.","duration":2,"changes":[{"element":"request","along":"hit","progress":0.4166666666666667}]},{"id":"hit-response","label":"Return the saved result","detail":"The database is skipped.","duration":2,"changes":[{"element":"request","along":"hit","progress":1}]},{"id":"miss-start","label":"Request starts at the client","detail":"There is no usable cached response.","duration":2,"changes":[{"element":"request","along":"miss","progress":0}]},{"id":"miss-cache","label":"Check the cache","detail":"The result is missing or expired.","duration":2,"changes":[{"element":"request","along":"miss","progress":0.358}]},{"id":"miss-query","label":"Fetch from the database","detail":"The request takes the longer route to fetch fresh data.","duration":2,"changes":[{"element":"request","along":"miss","progress":0.657}]},{"id":"miss-response","label":"Return the fresh result","detail":"The database was needed for this response.","duration":2,"changes":[{"element":"request","along":"miss","progress":1}]}],"scenarios":[{"id":"hit","label":"Cache hit","steps":["hit-start","hit-cache","hit-response"]},{"id":"miss","label":"Cache miss","steps":["miss-start","miss-cache","miss-query","miss-response"]}]}
```

### Follow a curved route

The same controls also work with one timeline and entirely different content.

```json
{"version":1,"kind":"scene","title":"A parcel follows the delivery route","description":"The orange dot is one parcel. Scrub the timeline to follow the curved route.","viewBox":[0,0,600,250],"elements":[{"id":"road","type":"path","d":"M60 180 C160 0 410 0 540 180","fill":"none","stroke":"#94a3b8","strokeWidth":3},{"id":"warehouse","type":"text","x":15,"y":215,"text":"Warehouse","fill":"#cbd5e1"},{"id":"delivery","type":"text","x":470,"y":215,"text":"Destination","fill":"#cbd5e1"},{"id":"legend","type":"text","x":20,"y":25,"text":"Orange dot = one parcel","fill":"#cbd5e1"},{"id":"request","type":"circle","cx":0,"cy":0,"r":10,"fill":"#fb923c"}],"states":[{"id":"packed","label":"Ready at the warehouse","detail":"The parcel has been packed.","duration":2,"changes":[{"element":"request","along":"road","progress":0}]},{"id":"transit","label":"Travel along the route","detail":"The parcel follows the road, including its curve.","duration":2,"changes":[{"element":"request","along":"road","progress":0.5}]},{"id":"delivered","label":"Arrive at the destination","detail":"Delivery is complete.","duration":2,"changes":[{"element":"request","along":"road","progress":1}]}]}
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
