'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but which always runs the latest
 * `fn`. A memoized child given one does not redraw just because its parent
 * did, while still seeing the parent's current state when it is called.
 * Only call the result from events and effects, never while rendering.
 */
export function useSteadyCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
