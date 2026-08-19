/**
 * Where each report colour lands in the app's own palette.
 *
 * `reporting/tools/blocks.py` names seven tones (`grey blue green amber red
 * violet teal`) and paints them from six fixed hex pairs in `page.css`. This
 * app has no such page of its own — every colour has to come from the 11
 * themes' CSS variables (`src/app/globals.css`, `src/app/themes.css`) so a
 * block reads correctly in all of them.
 *
 * Five of the seven tones land on an existing semantic token, the same ones
 * `badge.tsx` and `bead-card.tsx` already draw from: warning, info, success,
 * danger, epic. `grey` has no hue of its own in the report either — it is
 * muted text, so it takes the app's muted/overlay pair.
 *
 * `teal` is the one gap: no token in `globals.css` or any of the 10 themes in
 * `themes.css` holds a teal hue consistently. `--status-review` looked like a
 * candidate (it IS teal in the default dark theme) but drifts to violet, pink,
 * amber or pale purple in the other themes (checked all 11 blocks), and
 * `--chart-1..5` are not redefined per theme at all, so under the 10 custom
 * skins they would freeze at the default palette's colour. Rather than invent
 * a hex value this reuses `info` (blue) for teal — the nearest cool, calm
 * tone already wired to all 11 themes. Flagged here rather than silently
 * decided.
 *
 * Every class below is a complete literal string, never built with a template
 * — Tailwind only ships a class it can read as-is in the source
 * (src/lib/state-styles.ts explains the same constraint for status colours).
 */
import type { NoteTone, Tone } from './types';

export interface ToneClasses {
  /** Foreground colour — text, an icon, a chart's legend swatch border. */
  text: string;
  /** A soft tinted background, paired with `text` (pills, tile deltas). */
  soft: string;
  /** A solid fill, for a legend swatch or a bar segment's own background. */
  solid: string;
  /** A border in the same hue, low-opacity. */
  border: string;
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  grey: {
    text: 'text-t-muted',
    soft: 'bg-surface-overlay',
    solid: 'bg-t-muted',
    border: 'border-b-default',
  },
  blue: {
    text: 'text-info',
    soft: 'bg-info/15',
    solid: 'bg-info',
    border: 'border-info/30',
  },
  green: {
    text: 'text-success',
    soft: 'bg-success/15',
    solid: 'bg-success',
    border: 'border-success/30',
  },
  amber: {
    text: 'text-warning',
    soft: 'bg-warning/15',
    solid: 'bg-warning',
    border: 'border-warning/30',
  },
  red: {
    text: 'text-danger',
    soft: 'bg-danger/15',
    solid: 'bg-danger',
    border: 'border-danger/30',
  },
  violet: {
    text: 'text-epic',
    soft: 'bg-epic/15',
    solid: 'bg-epic',
    border: 'border-epic/30',
  },
  // No dedicated token — reuses `info`. See file header.
  teal: {
    text: 'text-info',
    soft: 'bg-info/15',
    solid: 'bg-info',
    border: 'border-info/30',
  },
};

/** The same seven tones, as the `hsl(var(--x))` a chart's SVG `fill`/`stroke` needs — classes don't reach those attributes. */
export const TONE_HSL: Record<Tone, string> = {
  grey: 'hsl(var(--text-muted))',
  blue: 'hsl(var(--info))',
  green: 'hsl(var(--success))',
  amber: 'hsl(var(--warning))',
  red: 'hsl(var(--danger))',
  violet: 'hsl(var(--epic))',
  teal: 'hsl(var(--info))',
};

/** The four `note` tones, a separate and smaller vocabulary from `Tone`. */
export const NOTE_CLASSES: Record<NoteTone, ToneClasses> = {
  info: TONE_CLASSES.blue,
  good: TONE_CLASSES.green,
  warn: TONE_CLASSES.amber,
  bad: TONE_CLASSES.red,
};

export function toneOf(t: Tone | undefined): ToneClasses {
  return TONE_CLASSES[t ?? 'grey'];
}
