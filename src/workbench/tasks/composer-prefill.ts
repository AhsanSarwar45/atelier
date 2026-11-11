'use client';

import { createContext, useContext } from 'react';

import { writeUnsentLine } from '@/workbench/drafts';

/**
 * Puts a line into the open chat's composer. The chat screen provides it; a
 * card drawn anywhere else has no composer to write into and gets null.
 */
export const ComposerPrefillContext = createContext<((line: string) => void) | null>(null);

export function useComposerPrefill(): ((line: string) => void) | null {
  return useContext(ComposerPrefillContext);
}

/** Adds a line to a chat's unsent text, on a line of its own. */
export function prefillChat(sessionId: string, line: string): void {
  writeUnsentLine(sessionId, (was) => (was.trim() ? `${was.replace(/\s+$/, '')}\n${line}` : line));
}
