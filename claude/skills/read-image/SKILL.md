---
name: read-image
description: Read an image for FACTS instead of recognising it — a systematic visual sweep across every dimension (geometry, angle, colour, tone, texture, structure, variation, lighting), enumerated in a table before any hypothesis. Use whenever a decision depends on what an image actually shows (a render, a photo, a plate, a chart, a screenshot, a UI, a diagram), and ALWAYS before stating any property of one. Stops the failure where a recognised label is reported in the vocabulary of measurement.
---

# read-image — recognition is not observation

## The failure this exists to stop

Looking at an image produces a **label** instantly and confidently: *"it's a maple"*,
*"the reflection looks right"*, *"the gradient is smooth"*, *"roughly 45°"*.
Observing produces **facts**, and costs a deliberate pass.

The label arrives free, so it wins — and then it gets reported in the vocabulary of
observation. `~45°` reads identically whether it came from a bisection against a
known anchor or from a vibe. The reader cannot tell, so the error survives and every
decision downstream inherits it.

**Recognition answers "what is this?". Almost every real question is "what exactly
is it doing?" — and recognition cannot answer that.** It is a lookup against a
category, so it returns the category's typical member, not the thing in front of
you. That is why it feels certain and is often wrong in the details that matter.

## ⛔ The hard rule

> **Every property you state carries how you got it.**

Three legitimate provenances, in descending order of trust:

| how | when | how to write it |
|---|---|---|
| **instrument** — a probe, a dump, an image tool | the artifact came from our code, or a tool exists | `0.18 (probe)` |
| **annotated overlay** — grid, protractor, scale bar, sampled swatch | a reference we did not generate | `55° (protractor overlay)` |
| **visual estimate by an explicit technique** — see below | quick reads, or nothing else is available | `~55° (bisected vs 45°/90°, ±5)` |

**A fourth — an unqualified number with no method — is banned.** If you have not
done one of the three, the honest output is `unmeasured`. That sentence is worth
more than a figure that might be invented.

Visual estimation is legitimate and often sufficient. What is banned is a
**quantity with no stated method and no uncertainty**.

## Visual measurement techniques — how to actually look

You are poor at absolute perceptual judgements and much better at **comparisons,
bisections and counts**. Convert every question into one of those.

- **Angles: bisect against anchors.** Never estimate an angle in the abstract. Fix
  0°, 45°, 90° in the frame, decide which pair the line falls between, then halve:
  *"between 45 and 90, nearer 45 → ~60"*. Accurate to about ±5° and honest about it.
- **Lengths and sizes: ratio to a feature in the same image.** *"the basal vein is
  0.3× the midvein"* is reliable; *"the basal vein is 40 mm"* is not. Ratios survive
  scale, crop and resolution.
- **Quantity: count, never estimate.** If there are fewer than ~30, count them and
  give the exact number. "Several", "many", "a dozen or so" are all failures.
- **Position: quarters, then eighths.** *"the widest point is at ~0.35 of the
  height"* — halve the frame, halve again.
- **Colour: name hue, value and saturation separately.** "Warm grey, mid value, low
  saturation" beats "greyish". Judge value by squinting past the hue; judge hue by
  comparing against a neutral in the same image. **Never judge a colour in
  isolation** — simultaneous contrast will shift it. Compare it to a neighbour.
- **Two scales, always.** Downscale hard (or squint) for *macro* structure —
  silhouette, mass distribution, tonal balance. Zoom to native or above for *micro* —
  edges, texture, artefacts. A defect is usually invisible at one of the two.
- **Look for what is absent.** The strongest findings are missing things: a tier
  that should exist, a gradient that should be there, a shadow with no occluder.
  Absence never announces itself — you have to go looking for it deliberately.

## The sequence

### 1. Global pass — establish the frame

Before any detail: what is depicted, what is the framing and scale, which way is
up, where is the light coming from, what is the background, what is the medium
(photo / render / scan / diagram / screenshot). Note anything that will distort
later readings — perspective, a wide lens, a crop, non-square pixels, a colour cast.

### 2. Systematic sweep at native resolution

⛔ **Never judge a downscaled whole.** A fit-to-screen view of a large image is a
thumbnail, and thumbnails hide exactly the defects worth finding.

Divide into tiles and visit **every** tile, in order. Not the interesting-looking
ones — all of them, or you will only ever confirm what you already expected.

```bash
magick in.png -crop 480x400+80+560 +repage -resize 300% tile.png
```

### 3. Enumerate every dimension

Walk this list explicitly. Skipping a row is a decision; make it a conscious one.

| dimension | what to extract |
|---|---|
| **geometry** | counts, angles, lengths as ratios, spacing, symmetry, alignment |
| **structure** | what connects to what, hierarchy, ordering, branching, nesting |
| **silhouette** | outline shape, convexity, where it is widest, aspect ratio |
| **tone** | black point, white point, where the mid-tones sit, contrast, clipping |
| **colour** | hue families, saturation range, casts, how many distinct colours, gradients |
| **texture** | detail frequency, direction, regular vs stochastic, grain, noise |
| **variation** | regular or irregular? density gradients? outliers? is variation itself patterned? |
| **lighting** | light direction, hardness of shadows, bounce, specular behaviour, occlusion |
| **material** | opaque/translucent/metallic, roughness cues, subsurface, wetness |
| **edges** | sharp or soft, and *where* — is softness uniform or does it vary spatially? |
| **artefacts** | compression, aliasing, banding, resampling, watermarks, JPEG rings |

Not every row applies to every image. **Variation** is the one most often skipped
and most often where the answer is: real things are irregular in patterned ways,
and generated things are usually irregular in the wrong way, or not at all.

### 4. Tabulate

Prose lets you write *"the primaries fan out widely"* and move on. A table has
empty cells, and an unfillable cell is a **visible** admission that you did not look.

| # | feature | value | how |
|---|---------|-------|-----|
| 1 | primaries per half | 3 | counted |
| 2 | divergence | 25 / 55 / 90° | bisected vs anchors, ±5 |
| 3 | midvein colour | near-white, no hue | sampled |

One row per object or property. Fill every cell or write `unmeasured`.

### 5. Only now form a hypothesis

Everything above is observation. A cause proposed before the table is a cause
proposed from the label — which is the failure this skill exists to stop.

## Prefer the instrument where one exists

If the artifact came out of **our own code**, the code already knows the answer —
print it. A probe that dumps the real values beats any amount of squinting, is
reproducible, and becomes a regression test later. Per
[`CLAUDE.md`](../../../CLAUDE.md), the *second* manual inspection becomes a tool: if
you are cropping the same region twice, stop and write the probe.

Useful annotation and sampling commands:

```bash
# grid overlay at quarters
magick in.png -stroke '#00ff0070' -strokewidth 1 \
  -draw "line 0,%[fx:h/4] %[fx:w],%[fx:h/4] line 0,%[fx:h/2] %[fx:w],%[fx:h/2]" out.png
# sample a colour
magick in.png -format '%[pixel:p{420,310}]' info:
# tone distribution
magick in.png -colorspace gray -format '%[fx:minima] %[fx:mean] %[fx:maxima]' info:
# dominant colours
magick in.png -resize 10% -colors 8 -unique-colors txt:
# edges, to see structure without tone
magick in.png -canny 0x1+10%+30% out.png
```

For a **reference we did not generate** there is no probe — that is what the
annotated overlay is for, and what
[`judge-against-reference`](../judge-against-reference/SKILL.md) covers.

## Reporting

- ✅ *"7 primaries (counted); divergence 25/55/90° per half (bisected vs anchors,
  ±5); basal pair horizontal, not downturned."*
- ✅ *"Highlight is clipped over ~2% of the frame (histogram); edges soften toward
  the corners, so the blur is not uniform."*
- ❌ *"The fan is roughly 45° and 85°."* — no method, no uncertainty.
- ❌ *"The colours look natural."* — a label, not an observation.
