"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

/**
 * Which rows of a long list are worth putting on the screen.
 *
 * A column of a hundred and fifty cards costs a hundred and fifty cards' worth
 * of screen even though five of them are in front of the reader, and the
 * browser pays for every one of them on every pass. This hands back the handful
 * that fall inside the scrolling pane — plus a band above and below, so
 * scrolling never shows a hole — and how tall the whole list would be, which is
 * what keeps the scrollbar honest about what is there.
 *
 * Rows are whatever height their contents need, so each drawn row is measured
 * once it is on the screen and remembered by its own key; a row never yet drawn
 * is guessed at `estimate` until it is. Measuring by key rather than by
 * position means a search that reorders the list keeps every height it already
 * knows.
 */

/** How far past the pane's edges a row is still worth drawing. */
const OVERSCAN = 250;

/** What a pane is assumed to be until it has been measured. */
const UNMEASURED_PANE = 800;

export interface DrawnRow {
  /** Where this row sits in the whole list. */
  index: number;
  /** The row's own key, as it was handed in. */
  key: string;
  /** How far down the list this row starts. */
  top: number;
}

export interface DrawnRows {
  /** The rows worth drawing, in list order. */
  rows: DrawnRow[];
  /** How tall the whole list is, drawn or not. */
  height: number;
  /** Goes on the pane that scrolls. */
  paneRef: (node: HTMLDivElement | null) => void;
  /** Goes on each drawn row, so its real height is learned. */
  rowRef: (key: string) => (node: HTMLDivElement | null) => void;
}

export interface DrawnRowsOptions {
  /** What a row is worth before it has been drawn once. */
  estimate: number;
  /** The space between one row and the next. */
  gap?: number;
  /** How far past the pane's edges to keep drawing. */
  overscan?: number;
  /**
   * A row that must be on the screen, whether or not the reader scrolled to it.
   *
   * Keyboard navigation walks a whole column and scrolls to whatever it lands
   * on, and a row that is not drawn cannot be scrolled to — so the pane is
   * moved to it here, which draws it, and the walking finds it there.
   */
  show?: string | null;
}

export function useDrawnRows(
  keys: readonly string[],
  { estimate, gap = 0, overscan = OVERSCAN, show = null }: DrawnRowsOptions,
): DrawnRows {
  // What each row turned out to be, and the node it is drawn in. Both are refs:
  // a measurement is not a fact the screen is drawn from until it changes one,
  // and `again` is what says it did.
  const tall = useRef(new Map<string, number>());
  const drawn = useRef(new Map<string, HTMLDivElement>());
  const refs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const [, again] = useReducer((n: number) => n + 1, 0);

  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [look, setLook] = useState({ top: 0, height: 0 });

  // Where the pane has been scrolled to, and how much of it there is. Both come
  // from the pane itself rather than from the window: the columns scroll inside
  // the board, and the board does not scroll at all.
  useEffect(() => {
    if (!pane) return;
    const read = () =>
      setLook((was) =>
        was.top === pane.scrollTop && was.height === pane.clientHeight
          ? was
          : { top: pane.scrollTop, height: pane.clientHeight },
      );
    read();

    // One read per frame at most: a scroll fires far faster than the screen is
    // drawn, and every extra read is a pass over the column for nothing.
    let waiting = false;
    const scrolled = () => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(() => {
        waiting = false;
        read();
      });
    };
    pane.addEventListener("scroll", scrolled, { passive: true });
    const sized = new ResizeObserver(read);
    sized.observe(pane);
    return () => {
      pane.removeEventListener("scroll", scrolled);
      sized.disconnect();
    };
  }, [pane]);

  // Every row's height is learned from the screen after it is drawn. Only a
  // change is worth another pass — otherwise this loops on itself forever.
  useLayoutEffect(() => {
    let moved = false;
    drawn.current.forEach((node, key) => {
      const height = node.offsetHeight;
      if (height <= 0) return;
      if (Math.abs((tall.current.get(key) ?? -1) - height) > 0.5) {
        tall.current.set(key, height);
        moved = true;
      }
    });
    if (moved) again();
  });

  const paneRef = useCallback((node: HTMLDivElement | null) => setPane(node), []);

  // One ref per key, kept, so a row that stays on the screen is not detached and
  // attached again on every pass.
  const rowRef = useCallback((key: string) => {
    let held = refs.current.get(key);
    if (!held) {
      held = (node: HTMLDivElement | null) => {
        if (node) drawn.current.set(key, node);
        else drawn.current.delete(key);
      };
      refs.current.set(key, held);
    }
    return held;
  }, []);

  // Where each row starts, and how tall the list is. A hundred and fifty
  // additions per pass is nothing beside a hundred and fifty cards.
  const tops = new Array<number>(keys.length);
  let at = 0;
  for (let i = 0; i < keys.length; i += 1) {
    tops[i] = at;
    at += (tall.current.get(keys[i]) ?? estimate) + gap;
  }
  const height = at > 0 ? at - gap : 0;

  // A row asked for by name is brought onto the screen once, when it is asked
  // for: doing it on every pass would fight the reader's own scrolling.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!show || !pane) {
      shown.current = null;
      return;
    }
    if (shown.current === show) return;
    shown.current = show;
    const at = keys.indexOf(show);
    if (at < 0) return;
    const top = tops[at];
    const deep = tall.current.get(show) ?? estimate;
    if (top < pane.scrollTop) {
      pane.scrollTo({ top, behavior: "smooth" });
    } else if (top + deep > pane.scrollTop + pane.clientHeight) {
      pane.scrollTo({ top: top + deep - pane.clientHeight, behavior: "smooth" });
    }
  });

  const from = look.top - overscan;
  const to = look.top + (look.height || UNMEASURED_PANE) + overscan;
  const rows: DrawnRow[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    if (tops[i] > to) break;
    const bottom = tops[i] + (tall.current.get(keys[i]) ?? estimate);
    if (bottom < from) continue;
    rows.push({ index: i, key: keys[i], top: tops[i] });
  }

  return { rows, height, paneRef, rowRef };
}
