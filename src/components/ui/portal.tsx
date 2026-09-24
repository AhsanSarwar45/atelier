'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Draws its children somewhere else in the page: into a slot another part of
 * the app holds open, or onto the body for something that floats over it all.
 *
 * Not Radix's `Portal`, though that is installed. Radix wraps what it moves in
 * a `div` of its own, and the places this is used are rows of controls laid out
 * by flex — an extra box between the row and its buttons changes their gaps
 * and their order. Its fallback is the other difference: handed no container
 * it draws on the body, where a slot that does not exist yet should mean
 * nothing is drawn. Here a `null` container draws nothing, so a caller waiting
 * on a slot does not have to say so twice.
 */
export function Portal({ container, children }: { container: Element | DocumentFragment | null; children: ReactNode }) {
  if (!container) return null;
  return createPortal(children, container);
}
