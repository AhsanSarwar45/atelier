---
name: judge-against-reference
description: Compare anything we generate against a ground-truth image — by ALIGNING and OVERLAYING them and tabulating both sides across every dimension (geometry, angle, colour, tone, texture, variation, lighting), never by alternating glances or by a scalar residual. Use before claiming a generated result matches, or is closer to, a reference. Stops "measurably improved" claims made against a metric blind to the thing being judged.
---

# judge-against-reference — overlay, tabulate, then claim

Builds on [`read-image`](../read-image/SKILL.md), which governs reading **one**
image and defines the provenance rule every number here inherits. This one governs
comparing **two**.

## The three failures this exists to stop

**1. Alternating glances.** Look left, look right, reconstruct from memory,
conclude *"it looks about right"*. Vision is excellent at spotting a difference
between two **superimposed** things and poor at comparing two things held in
memory. Side-by-side is memory comparison. **Overlay is difference detection.**

**2. A scalar that does not cover the claim.** A residual, an RMSE, a histogram
delta — each covers exactly one aspect. Reporting *"0.175 → 0.142, improving"*
while the metric scores only the silhouette, and the defect is in the interior
structure, is not a weak claim. It is a **false** one.

> ⛔ **Before quoting any metric, state what it is blind to.**
> If you cannot say what it does not cover, you do not know what it measures.

**3. Judging one dimension and claiming the whole.** The shape can match while the
colour, the texture, the variation and the lighting are all wrong. "Matches the
reference" is a claim about every dimension in the table, not the one you looked at.

## The sequence

### 0. Pin the reference before writing any code

The ground-truth artifact must exist, in the repo, at a known path, **first**.
Writing a pipeline before opening the reference is how a whole subsystem gets built
against an imagined target. If you do not have it, **ask**. That question is
cheaper than any amount of work aimed at the wrong thing, and reference material is
usually already in the repo under a `reference/` folder beside the outputs.

### 1. Align: same scale, same origin, same orientation

An overlay of two differently-scaled images is worse than useless: the mismatch it
shows is the scaling. Normalise on something both sides share, such as total
height, a bounding box, a landmark, a known anchor point.

Put the alignment in a script, not a one-off command. You will run it dozens of
times.

### 2. Overlay: three ways, all of them

Side-by-side is for the report, never for the judging.

```bash
# superimposed, ours tinted — where the shapes disagree
magick ref.png \( ours.png -fill red -colorize 60% \) -compose over -composite ab.png
# difference — what changed, and only that
magick ref.png ours.png -compose difference -composite -auto-level diff.png
# blink — both at identical scale and crop, read in succession
# structure only, tone removed — compares layout independent of brightness
magick ref.png -canny 0x1+10%+30% r.png; magick ours.png -canny 0x1+10%+30% o.png
```

For colour and tone, compare the **distributions**, not two sampled pixels:

```bash
magick ref.png -resize 10% -colors 8 -unique-colors txt:
magick ref.png -colorspace gray -format '%[fx:minima] %[fx:mean] %[fx:maxima]\n' info:
```

### 3. Tabulate BOTH sides: same rows, same units, every dimension

This step produces the finding. One table, with a column for the reference and a
column for ours, a column for the delta. Walk the full dimension list from
[`read-image`](../read-image/SKILL.md) §3: geometry, structure, silhouette, tone,
colour, texture, **variation**, lighting, material, edges.

| dimension | reference | ours | Δ |
|---|---|---|---|
| count | 7 (counted) | 7 (probe) | 0 |
| divergence | 25 / 55 / 90° (bisected, ±5) | 29 / 61 / 90° (probe) | +4 / +6 / 0 |
| aspect | 1.22 w:h (measured) | 1.7 w:h (probe) | +0.5 |
| variation | irregular, patterned | uniform | **structural** |

Reference values come from annotated overlays or explicit visual technique. Ours
comes from a probe in our own code, **never from the render**. `unmeasured` is a
legitimate cell. An invented number is not.

**Variation is the row most often skipped and most often where the answer is.**
Things are irregular in patterned ways. Generated things are usually uniform,
or irregular in a way that reads as noise. A perfect match on every other row with
this row wrong still looks fake.

### 4. Rank the mismatches, fix the largest

The table gives an ordering for free. Work the biggest Δ, and prefer a **structural**
mismatch (something categorically absent) over a numeric one, because no amount of tuning
fixes a missing tier. Do not fix the thing you happen to have a theory about.

### 5. Re-render into the working tree, at the committed path

The user judges the same file you do. After every change, regenerate the comparison
image **where it lives**, so what is on disk is what you are talking about. Never
report a conclusion from an output a later run has overwritten. Check the mtime if
there is any doubt (`ls --time-style=full-iso`).

Sweeps and ablations overwrite the output on every cell. When a sweep picks a
winner, **bake it into the source and re-render** before judging or reporting.

## Claiming

- ✅ *"Basal member 0.06 → 0.25 of the whole (probe). Reference visibly over half
  (unmeasured). Fan 23/50/85° → 29/61/90° against a reference 25/55/90°
  (protractor). Colour and variation not yet compared."*
- ❌ *"Residual 0.117 → 0.101, closer to the reference."* The residual scores the
  silhouette and cannot see the interior.
- ❌ *"It matches now."* That is a claim about every row. Make it only with the table.

If the overlay shows the result got worse, say so plainly, with the overlay, before
any of the numbers that went the other way.

## Write like a person

Say it the way you would say it out loud to the person who reads it. Lead with
what changed for them, use "I" and "you", ordinary verbs and contractions, and
give bad news first and flat. Say the fact, then stop, with no summarising
clause after a dash and no closing line that sounds like a moral.
`machinery/voice-check.py` measures what it can of this.
