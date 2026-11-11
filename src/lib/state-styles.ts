/**
 * The class names each status colour produces.
 *
 * Written out rather than built from the tone, because Tailwind only ships a
 * class it can read as a literal string in the source: `text-status-${tone}`
 * compiles to no colour at all. This is the one place that spelling lives.
 */

/** A status colour, named after its CSS token (`--status-<tone>`). */
export type Tone = "open" | "progress" | "review" | "closed" | "cancelled";

export const TONE_NAMES: readonly Tone[] = ["open", "progress", "review", "closed", "cancelled"];

export interface ToneClasses {
  /** Text colour, for a label or a status dot. */
  text: string;
  /** A badge's fill, ink and edge. */
  badge: string;
}

const TONES: Record<Tone, ToneClasses> = {
  open: {
    text: "text-status-open",
    badge: "bg-status-open/20 text-status-open border-status-open/30 hover:bg-status-open/20",
  },
  progress: {
    text: "text-status-progress",
    badge: "bg-status-progress/20 text-status-progress border-status-progress/30 hover:bg-status-progress/20",
  },
  review: {
    text: "text-status-review",
    badge: "bg-status-review/20 text-status-review border-status-review/30 hover:bg-status-review/20",
  },
  closed: {
    text: "text-status-closed",
    badge: "bg-status-closed/20 text-status-closed border-status-closed/30 hover:bg-status-closed/20",
  },
  cancelled: {
    text: "text-status-cancelled",
    badge: "bg-status-cancelled/20 text-status-cancelled border-status-cancelled/30 hover:bg-status-cancelled/20",
  },
};

/** What an unknown status reads as: muted, never coloured. */
const UNKNOWN: ToneClasses = {
  text: "text-t-tertiary",
  badge: "bg-t-muted/20 text-t-tertiary border-t-muted/30 hover:bg-t-muted/20",
};

/**
 * The classes for a tone, or the muted set when there is none — a status not
 * known, or not answered yet, which is what `undefined` means (bw-pq2a.3).
 */
export function classesFor(tone: Tone | undefined): ToneClasses {
  return tone ? TONES[tone] : UNKNOWN;
}
