'use client';

/**
 * Which open files have edits that are not on disk yet (bw-g3o3.8).
 *
 * A store of its own rather than a piece of the viewer's state, because the
 * dirty dot has to appear in two places at once that are not each other's
 * parent: the header above the file being edited, and the open-files strip
 * across the top (bw-g3o3.14), which draws files nobody is looking at. Passing
 * the flag down would mean lifting the whole of the editing state above both,
 * and the strip would then re-render on every keystroke into any file.
 *
 * So the only thing shared is the one bit that both of them draw: the set of
 * paths with unsaved work. `useSyncExternalStore` is what makes that safe under
 * concurrent React — a snapshot the renderer can be handed twice and get the
 * same answer from — and it is why {@link paths} is a frozen array kept until
 * the set actually changes rather than rebuilt per read.
 *
 * The window guard lives here too, for the same reason: it is about all of the
 * unsaved files rather than any one of them, and the browser only lets a page
 * ask "are you sure" from a `beforeunload` handler that is already installed.
 */

import { useSyncExternalStore } from 'react';

const unsaved = new Set<string>();
const listeners = new Set<() => void>();

/**
 * The current set as an array, rebuilt only when it moves.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders whenever
 * they differ, so a getter that built a new array each call would spin.
 */
let snapshot: readonly string[] = [];

/** What the browser asks with while something is unsaved. */
function refuseToLeave(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Chrome ignores the message and shows its own, but still requires that
  // something was assigned before it will ask at all.
  event.returnValue = '';
}

function announce() {
  snapshot = Object.freeze([...unsaved].sort());
  // The guard is installed only while it is needed. A page that permanently
  // holds a `beforeunload` listener is one the browser will not put in its
  // back/forward cache, which costs every navigation in the app.
  if (typeof window !== 'undefined') {
    if (unsaved.size > 0) window.addEventListener('beforeunload', refuseToLeave);
    else window.removeEventListener('beforeunload', refuseToLeave);
  }
  for (const listener of listeners) listener();
}

/**
 * Say whether `path` has edits that are not on disk.
 *
 * Idempotent on purpose: it is called from a render-driven effect on every
 * keystroke, and only a real change announces one.
 */
export function markUnsaved(path: string, dirty: boolean): void {
  if (dirty === unsaved.has(path)) return;
  if (dirty) unsaved.add(path);
  else unsaved.delete(path);
  announce();
}

/** Whether `path` has unsaved edits right now, outside of React. */
export function isUnsaved(path: string): boolean {
  return unsaved.has(path);
}

/** Every path with unsaved edits, sorted, outside of React. */
export function unsavedPaths(): readonly string[] {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The paths with unsaved edits, redrawn when the set moves. What the
 * open-files strip puts its dots on.
 */
export function useUnsavedPaths(): readonly string[] {
  return useSyncExternalStore(subscribe, unsavedPaths, unsavedPaths);
}

/** Whether one file has unsaved edits, redrawn when that answer moves. */
export function useIsUnsaved(path: string | null): boolean {
  const paths = useUnsavedPaths();
  return path != null && paths.includes(path);
}

/**
 * Forget everything, for a test that must not inherit the last one's files.
 * Nothing in the app calls this: a file stops being unsaved by being saved.
 */
export function forgetUnsaved(): void {
  if (unsaved.size === 0) return;
  unsaved.clear();
  announce();
}
