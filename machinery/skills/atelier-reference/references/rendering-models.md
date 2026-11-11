# Computed rendering models

Use `kind: "render"` when the reader needs to change a numerical parameter and
inspect its effect on actual image buffers. Use `scene` for a narrated geometric
illustration. A render artifact evaluates a bounded numerical model; it is not
a game engine, a GPU benchmark, or an arbitrary shader host.

Atelier supplies 2–4 synchronized image panes, one frame timeline, Play/Pause,
Replay, parameter sliders, and a pixel inspector. Clicking a pane selects the
same pixel in every pane. Arrow keys move selection; X/Y inputs also work.
The inspector shows every buffer at that coordinate in both the current and
previous frame, and can display buffers not used by the comparison panes.
Changing a parameter pauses playback and recomputes all frames from the initial
conditions. Reset parameters restores defaults and frame 0. Reduced motion
keeps manual frame selection available and disables automatic playback.

## Contract

Use `version: 1`, `kind: "render"`, `title` and optional `description` (1,000
characters). Explain the question, units, assumptions and omissions. The scene's
pixel grid is illustrative unless you have supplied a validated physical model.

- `width`, `height`: integers 1–64. Pixel coordinates start at (0,0), top left.
- `frames`: integer 1–60; frame indices start at 0.
- `fps`: integer 1–30, playback speed only. It is not a measured performance.
- `parameters`: 0–8 `{id,label,min,max,step,value}` objects. IDs must be unique
  and cannot be `x`, `y`, `width`, `height`, or `frame`. Bounds increase, step is
  positive and no larger than the span, and value must be in range.
- `buffers`: 1–8 `{id,label,channels,values,initial?}` objects in calculation
  order. `channels` contains 1–4 unique channel labels. `values` contains one
  expression per channel. Optional `initial` gives one number per channel;
  otherwise it is zero. It describes the entire buffer before frame 0.
- `views`: 2–4 `{id,label,buffer,display,channels,range,encoding?}` objects.
  `buffer` names an existing buffer. `display` is `scalar`, `vector`, or `rgb`;
  `channels` is respectively 1, 2, or 3 zero-based channel indices. `range` is
  `[min,max]`, with min < max, and stays fixed across frames for comparison.
  Scalar displays grayscale. Vector displays the first channel as red, second
  as green, and a fixed half-intensity blue; it is not an arrow plot.
  RGB optionally uses `encoding: "linear"` to convert normalized linear RGB to
  sRGB for display; omitted or `"raw"` applies no transfer function.

All IDs use letters, numbers, underscores or hyphens, start with a letter and
have at most 64 characters. Labels are nonempty and at most 200 characters.
Numeric literals, parameter bounds and display ranges must be finite and have
absolute value at most 1,000,000. Unknown fields and null optional fields fail
validation. Every buffer and view needs a unique ID in its own list.

The display normalizes to its declared range and clips to [0,1]. **Raw buffer
values are never clipped to the display range.** Inspector-only buffers without
a declared view use a range expanded from [0,1] to include the current frame's
values; read the displayed range before comparing their colors across frames.

## Expressions

An expression is a number, a variable name, or an operation array. Variables are
parameter IDs plus `x`, `y`, `width`, `height`, and `frame`. No code strings,
network access, dynamic imports, loops, assignment, or executable callbacks.

| Form | Meaning |
|---|---|
| `["add",a,b]`, `sub`, `mul`, `div` | Arithmetic |
| `["mod",a,b]` | Remainder, with the sign of a |
| `["min",a,b]`, `["max",a,b]` | Minimum, maximum |
| `["abs",a]`, `floor`, `sin`, `cos`, `sqrt` | Unary math; angles in radians |
| `["lt",a,b]`, `le`, `gt`, `ge`, `eq` | Comparison, returns 1 or 0 |
| `["and",a,b]`, `["or",a,b]` | Nonzero means true; returns 1 or 0 |
| `["if",condition,yes,no]` | Only the selected branch is evaluated |
| `["mix",a,b,t]` | a × (1−t) + b × t; t is not implicitly clamped |
| `["clamp",value,min,max]` | Clamp a scalar |
| `["sample",buffer,channel,x,y,"current"]` | Read an earlier buffer this frame |
| `["sample",buffer,channel,x,y,"previous"]` | Read any buffer one frame earlier |

Samples use nearest-neighbor coordinates: floor(coordinate + 0.5), clamped to
image edges. At frame 0, a previous-frame read returns that buffer's `initial`
channel value. Current-frame forward/self references are rejected, so there is
no dependency cycle within a frame. Previous-frame references may target any
buffer, including the same buffer. To detect out-of-bounds reprojection,
explicitly test coordinates before sampling; clamping does not make history
valid. This engine does not implement bilinear filtering implicitly.

Buffers store IEEE float32 values after each pass; expression arithmetic uses
JavaScript numbers. Division by zero, invalid square roots, nonfinite results,
or intermediate magnitudes over 1e12 report an error instead of drawing a
misleading image. Float precision and sampling are part of the model: do not
claim equivalence with a particular GPU implementation without comparison.

Limits: expression nesting depth 12, at most 512 expression nodes across all
buffers, and width × height × frames × nodes ≤ 6,000,000. Computation runs in a
worker; parameter changes and unmount cancel the old worker. A 10-second
watchdog stops a stalled computation. Reduce model size if a limit is hit.

## Examples and checks

Read the complete JSON examples using the skill resource reader:

- `references/render-taa.json`: moving foreground, color, depth, motion vectors,
  reprojected history, validity mask, unchecked accumulation and depth-rejected
  accumulation. Compare both outputs at the same frame. At frame 1, pixel
  (4,8), default parameters give red ≈0.777 without rejection and ≈0.08 with
  rejection. Raising the depth threshold to 1 admits stale history. This is
  a computed temporal resolve demonstration, **not full TAA**: it omits jitter,
  reconstruction filters, neighborhood clipping, and a 3D rasterizer.
- `references/render-filter.json`: three-tap horizontal and vertical sampling,
  followed by unsharp masking. At (11,8), amount 1 gives ≈1.033333, which clips
  in the displayed image but remains visible numerically. This independently
  exercises the same model contract without temporal accumulation.

Save one JSON object and run `atelier tool present artifact --file FILE`.
Do not paste presenter output. Before presenting a new model, check a small
case with known numbers; a picture alone cannot establish numerical accuracy.
Use fixed display ranges for side-by-side comparisons, label every buffer and
parameter, and say which real algorithm details the demonstration omits.

## Primary references

- [Yang, Liu and Salvi: A Survey of Temporal Antialiasing Techniques](https://research.nvidia.com/labs/rtr/publication/yang2020survey/): accumulation and history validation are separate parts of TAA.
- [MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects): transfer worker-owned buffer storage instead of copying it.
- [MDN Worker.terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate): immediately stop an obsolete computation.
- [W3C CSS Color 4 conversion code](https://www.w3.org/TR/css-color-4/#color-conversion-code): linear RGB to sRGB display transfer.
