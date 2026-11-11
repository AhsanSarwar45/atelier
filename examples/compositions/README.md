# Directed explanations

Use a composition when the reader needs a guided sequence: reveal a structure,
focus on one part, animate a test, show its consequence, then return to context.
Use the existing mesh/render widgets when the reader needs to explore parameters.

## Author and present

```sh
npm ci
node scripts/compositions/build.mjs examples/compositions/meshlets.tsx /tmp/meshlets.json
atelier tool present artifact --file /tmp/meshlets.json
```

The presenter must come from a build that supports `kind: "composition"`.
The JSON output contains the bundled player, composition and assets. Playback
needs no development server, CDN or package downloads. It survives chat reload.

Create `your-topic.tsx` exporting a default React component and a sibling
`your-topic.json`:

```json
{"title":"How a cache avoids repeated work","width":1280,"height":720,"fps":30,"durationInFrames":900,"chapters":[{"frame":0,"label":"First request"},{"frame":450,"label":"Cache hit"}]}
```

The component has the full Remotion API, not a fixed set of animated shapes.
Optional `inputProps` in the JSON supplies editable domain data to the component.
Use `Sequence`, `interpolate`, `spring`, SVG, HTML, canvas and `ThreeCanvas`.
Import local PNG/JPEG/WebP/SVG/audio/font assets to embed them. The bundle limit
is 8 MiB including JSON; use the video widget for larger finished films.

Every visual state must derive from `useCurrentFrame()`. Do not use wall-clock
animation, unseeded randomness, CSS animation or R3F `useFrame` for the film.
Seeking must reproduce the same geometry, labels and numbers. `ThreeCanvas`
shares Remotion's frame clock. Audio can be imported and sequenced using
Remotion's audio components; the included example is captioned, without voiceover.

## Storyboard before code

Write the reader's question and one intended takeaway. Plan 4–6 shots. For each:

1. What is visible at the beginning?
2. What changes, and what does that change mean?
3. Where does the viewer look? Attach a short label to that object.
4. What deserves a hold before moving on?

Show the event before explaining its consequence. Prefer one short caption and
one or two attached labels per shot. Keep names and colors stable. Use close-ups
for a boundary test and a wide shot to recover context. Chapters are meaningful
places to revisit, not a button for each animation step. Let the animation carry
the explanation: a still diagram with changing paragraphs is not sufficient.

## Inspect before presenting

Build and open the actual artifact in a disposable Atelier app with private
Chrome. Watch at normal speed. Seek every chapter and its midpoint, replay and
pause. Check narrow and full-screen playback. Capture representative frames and
a video segment. Confirm geometric tests against real calculations; distinguish
an illustrative model from production data. Revise cramped labels, abrupt cuts,
unreadable captions and unmotivated movement before sharing.

The meshlet film is a worked example, not a template all subjects must resemble.
Keep the sphere test conservative: partial overlap is retained; retained does
not prove visibility. Backface cone culling is separate from occlusion culling.

## Isolation and licensing

Building runs locally as an ordinary authoring command. The server never compiles
or executes a composition. Playback runs inside an opaque-origin iframe with
scripts enabled, no same-origin permission and a restrictive CSP. It cannot use
app APIs, cookies, parent DOM or external resources. Embed required assets; do
not add network exceptions to make a composition work. This browser boundary
limits access, not CPU/GPU consumption: inspect authored code before presenting.

Remotion is source-available under its own license, not Atelier's MIT license.
Check eligibility and deployment requirements before commercial use:
https://www.remotion.dev/docs/license/pricing

Primary API references:
- https://www.remotion.dev/docs/player
- https://www.remotion.dev/docs/three
- https://www.remotion.dev/docs/sequence
- https://www.remotion.dev/docs/ai/skills
