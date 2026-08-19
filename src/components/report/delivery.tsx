/**
 * Where an answer goes when the manager sends it (bw-7ks.21.5).
 *
 * The report document itself knows nothing about projects — it is rendered
 * from a spec and nothing else — but posting an answer needs the project's own
 * directory: every `bd` call is run there, and the board's join of cards to
 * chats is asked for a path. The screen that owns the project supplies it here,
 * and where nothing does — a report drawn outside a project — the answer keeps
 * its old ending, a line to copy by hand.
 */
'use client';

import { createContext, useContext, type ReactNode } from 'react';

export interface Delivery {
  /** The project's own directory on this machine. */
  projectPath: string;
}

const DeliveryContext = createContext<Delivery | null>(null);

export function DeliveryProvider({ value, children }: { value: Delivery | null; children: ReactNode }) {
  return <DeliveryContext.Provider value={value}>{children}</DeliveryContext.Provider>;
}

/** The project this report can post into, or null when it can post nowhere. */
export function useDelivery(): Delivery | null {
  return useContext(DeliveryContext);
}
