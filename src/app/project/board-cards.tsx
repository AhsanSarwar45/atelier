/**
 * One card list for the project screen, read once and shared.
 *
 * The board draws it and the card panel reads the open card out of it, so an
 * edit made in the panel moves the card behind it at once. Two copies meant two
 * fetches of the same list and a panel whose refresh the board never heard
 * about — on a Dolt-backed board, until its 15-second backstop (bw-m8o.11).
 *
 * Mounted only while something needs it: with no card open, the chat tab pays
 * nothing for the board's list (docs/designs/app-shell.md §1.6).
 */
'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { useBeads, type UseBeadsResult } from '@/hooks/use-beads';

const Cards = createContext<UseBeadsResult | null>(null);

export function BoardCards({ projectPath, children }: { projectPath: string; children: ReactNode }) {
  const cards = useBeads(projectPath);
  return <Cards.Provider value={cards}>{children}</Cards.Provider>;
}

/**
 * The shared list. Throws rather than quietly fetching a second copy: a part
 * that needs the cards belongs inside the provider, and a silent fallback is how
 * the two lists happened in the first place.
 */
export function useBoardCards(): UseBeadsResult {
  const cards = useContext(Cards);
  if (!cards) throw new Error('this part reads the board’s cards and must be mounted inside <BoardCards>');
  return cards;
}
