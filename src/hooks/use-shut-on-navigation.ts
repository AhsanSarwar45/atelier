'use client';

import { useEffect, useRef } from 'react';

import { useSearchParams } from 'next/navigation';

/**
 * Shuts a phone's drawer whenever the address changes.
 *
 * A drawer is opened to get somewhere, so once the screen has moved on it has
 * done its job. Each way out of it used to shut it by hand, and every way that
 * forgot — Back, a chat opened from search, the project's settings — left it
 * standing over the page it had led to. Watching the address catches all of
 * them, including the ones not written yet.
 *
 * The address the screen first drew with is not a change: a drawer a screen
 * opens for itself on arrival stays open.
 */
export function useShutOnNavigation(shut: () => void) {
  // The query alone: both drawers live on the project screen, where every move
  // is a change of query, and leaving the screen takes the drawer with it.
  const address = useSearchParams().toString();
  const seen = useRef(address);
  useEffect(() => {
    if (seen.current === address) return;
    seen.current = address;
    shut();
  }, [address, shut]);
}
