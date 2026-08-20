/**
 * What each family of machine line looks like: its colour and its mark.
 *
 * Split from the sorting next door so that reading the sorting costs nothing at
 * run time — see `machine-lines.ts`. Which family a line lands in is decided
 * there; this file only says how that family is drawn.
 *
 * The classes are written out one family at a time and never built from the
 * family's name: Tailwind ships a class only when it read the literal string in
 * the source, which is exactly how the board's own state colours went grey
 * (src/lib/state-styles.ts, bw-ufso.2). `__tests__/machine-lines.test.tsx` runs
 * the real Tailwind over the real tree and fails if one stops coming out.
 */
import { Bot, Circle, CircleStop, FoldVertical, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react';

import type { MachineFamily } from '@/workbench/machine-lines';

export interface FamilyLook {
  /** The row itself: its tint, its edge and the colour of its words. */
  row: string;
  /** How many times in a row this kind happened. */
  count: string;
}

/**
 * The look of each family. Spelled out, never interpolated — see the note above.
 *
 * `breathing` is the machine's own breathing and is the one family with no
 * tint: it is grey on purpose, because it is what the reader scrolls past
 * rather than what stopped the work.
 */
const LOOKS: Record<MachineFamily, FamilyLook> = {
  stopped: {
    row: 'border-warning/35 bg-warning/10 text-warning',
    count: 'bg-warning/20 text-warning',
  },
  failed: {
    row: 'border-danger/35 bg-danger/10 text-danger',
    count: 'bg-danger/20 text-danger',
  },
  waiting: {
    row: 'border-status-review/35 bg-status-review/10 text-status-review',
    count: 'bg-status-review/20 text-status-review',
  },
  memory: {
    row: 'border-epic/35 bg-epic/10 text-epic',
    count: 'bg-epic/20 text-epic',
  },
  background: {
    row: 'border-info/35 bg-info/10 text-info',
    count: 'bg-info/20 text-info',
  },
  breathing: {
    row: 'border-t-faint/30 bg-transparent text-t-faint',
    count: 'bg-t-faint/20 text-t-faint',
  },
};

export const lookOf = (family: MachineFamily): FamilyLook => LOOKS[family];

/** The mark on the chip. One per family, so the colour is never the only signal. */
const MARKS: Record<MachineFamily, LucideIcon> = {
  stopped: CircleStop,
  failed: TriangleAlert,
  waiting: RefreshCw,
  memory: FoldVertical,
  background: Bot,
  breathing: Circle,
};

export const markOf = (family: MachineFamily): LucideIcon => MARKS[family];
