/**
 * Which part of an open report the reader is looking at right now.
 *
 * Tracks the same ids the table of contents scrolls to (`report-document.tsx`'s
 * `act`/`stat`/`s1..sN`/`dec`/`next`), so the contents rail can mark one of them
 * current as the reader scrolls, not only when they click (bw-7ks.21.4).
 *
 * A part counts as current once it has crossed into a thin band near the top of
 * the reading pane — not merely once any part of it is visible, or two parts
 * both read as current while one scrolls out from under the other. Among the
 * ids currently in that band, the last one in reading order is the answer: as
 * the reader scrolls down, ids enter the band in document order, and whichever
 * entered most recently is the one they are reading.
 */
'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

export function useActiveSection(ids: string[], root: RefObject<HTMLElement | null>): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const inBand = useRef<Set<string>>(new Set());

  useEffect(() => {
    const rootEl = root.current;
    if (!rootEl || ids.length === 0) return undefined;

    const targets = ids.map((id) => document.getElementById(id)).filter((n): n is HTMLElement => n !== null);
    if (targets.length === 0) return undefined;

    inBand.current = new Set();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          const id = (r.target as HTMLElement).id;
          if (r.isIntersecting) inBand.current.add(id);
          else inBand.current.delete(id);
        }
        for (let i = ids.length - 1; i >= 0; i--) {
          const id = ids[i]!;
          if (inBand.current.has(id)) {
            setActive(id);
            return;
          }
        }
      },
      // A band across the top fifth of the pane: a part is "current" as soon as
      // its heading reaches there, not only once it fills the whole pane.
      { root: rootEl, rootMargin: '0px 0px -80% 0px', threshold: 0 },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [ids, root]);

  return active;
}
