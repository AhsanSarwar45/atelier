/**
 * The class names each state's colour produces.
 *
 * Written out rather than built from the tone, because Tailwind only ships a
 * class it can read as a literal string in the source: `text-status-${tone}`
 * compiles to no colour at all. This is the one place that spelling lives.
 *
 * Keyed by tone and typed against the one list of states, so a state added
 * there with a colour nobody has drawn yet fails to build instead of quietly
 * rendering grey.
 */
import type { BeadStatus, StateInfo } from "@/types";
import { STATE_BY_ID } from "@/types";

type Tone = StateInfo["tone"];

export interface ToneClasses {
  /** Text colour, for a label or a status dot. */
  text: string;
  /** Top rule on a column header. */
  borderTop: string;
  /** The count badge on a column header. */
  badge: string;
}

const TONES: Record<Tone, ToneClasses> = {
  open: {
    text: "text-status-open",
    borderTop: "border-t-2 border-t-status-open/60",
    badge: "bg-status-open/20 text-status-open border-status-open/30 hover:bg-status-open/20",
  },
  progress: {
    text: "text-status-progress",
    borderTop: "border-t-2 border-t-status-progress/60",
    badge: "bg-status-progress/20 text-status-progress border-status-progress/30 hover:bg-status-progress/20",
  },
  review: {
    text: "text-status-review",
    borderTop: "border-t-2 border-t-status-review/60",
    badge: "bg-status-review/20 text-status-review border-status-review/30 hover:bg-status-review/20",
  },
  manager: {
    text: "text-status-manager",
    borderTop: "border-t-2 border-t-status-manager/60",
    badge: "bg-status-manager/20 text-status-manager border-status-manager/30 hover:bg-status-manager/20",
  },
  closed: {
    text: "text-status-closed",
    borderTop: "border-t-2 border-t-status-closed/60",
    badge: "bg-status-closed/20 text-status-closed border-status-closed/30 hover:bg-status-closed/20",
  },
  cancelled: {
    text: "text-status-cancelled",
    borderTop: "border-t-2 border-t-status-cancelled/60",
    badge: "bg-status-cancelled/20 text-status-cancelled border-status-cancelled/30 hover:bg-status-cancelled/20",
  },
};

/** What a state left over from an older board reads as: muted, never coloured. */
const UNKNOWN: ToneClasses = {
  text: "text-t-tertiary",
  borderTop: "border-t-2 border-t-t-muted/60",
  badge: "bg-t-muted/20 text-t-tertiary border-t-muted/30 hover:bg-t-muted/20",
};

/** The classes for a state, or the muted set when the board sends one we do not know. */
export function classesFor(status: BeadStatus): ToneClasses {
  const tone = STATE_BY_ID[status]?.tone;
  return tone ? TONES[tone] : UNKNOWN;
}

/**
 * The colour itself, for the places that set a CSS variable rather than a class.
 * A variable name is not a Tailwind class, so this one can be built from the tone.
 */
export function colorFor(status: BeadStatus): string {
  const tone = STATE_BY_ID[status]?.tone;
  return tone ? `hsl(var(--status-${tone}))` : "hsl(var(--text-muted))";
}
