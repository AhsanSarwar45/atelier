import type { Bead } from '@/types';

export interface BoardIndex {
  beadById: ReadonlyMap<string, Bead>;
  statusById: ReadonlyMap<string, string>;
}

/** The two lookups every card needs, built in one walk of the board. */
export function indexBoard(beads: Iterable<Bead>): BoardIndex {
  const beadById = new Map<string, Bead>();
  const statusById = new Map<string, string>();
  for (const bead of beads) {
    beadById.set(bead.id, bead);
    statusById.set(bead.id, bead.status);
  }
  return { beadById, statusById };
}
