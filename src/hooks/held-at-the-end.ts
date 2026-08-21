'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Whether the reader is watching the end of a scrolling pane — and, while he
 * is, keeping him there.
 *
 * A chat used to put its end back in view on every change to the transcript,
 * without ever asking where the reader was. An answer arriving rewrites the
 * conversation on every word of it, so reading history while the agent talked
 * meant being dragged back down several times a second (bw-n6yh).
 *
 * What every chat does instead: the end is FOLLOWED while the reader is
 * watching it and left alone the moment he scrolls away, and he is the only one
 * who decides which. So the answer is read off the pane itself — how far the
 * end is from the bottom of what he can see — rather than remembered as a mode,
 * which cannot drift out of step with what is on the screen.
 *
 * The pane is moved by the app as well as by him: to keep the end in view, and
 * to hold his place when older messages arrive above him. Those moves are aimed,
 * and a move that lands where it was aimed is the app's own and says nothing
 * about him — that is `aimed`. Anything he does with a wheel, a finger or a key
 * cancels the aim, because from then on the pane is his.
 */

/** How far from the end still counts as watching it. */
const NEAR = 64;

export interface HeldAtTheEnd {
  /** Whether the end of the pane is what the reader is watching. */
  held: boolean;
  /** Put the end back in view, and follow it again. */
  toTheEnd: (how?: ScrollBehavior) => void;
  /** Move the pane as the app's own doing, without it counting as the reader's. */
  quiet: (move: () => void) => void;
  /** Goes on the box holding the rows, so what it does to its own height is noticed. */
  contentRef: (node: HTMLElement | null) => void;
}

/** What the pane would have to be scrolled to for its end to be in view. */
function end(box: HTMLElement): number {
  return box.scrollHeight - box.clientHeight;
}

export function useHeldAtTheEnd(pane: React.RefObject<HTMLElement | null>, near = NEAR): HeldAtTheEnd {
  const [held, setHeld] = useState(true);
  /** The same answer, readable from a listener that must not be torn down to see it. */
  const holding = useRef(true);
  /** Where the app last aimed the pane, or nothing while the pane is the reader's. */
  const aimed = useRef<number | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);

  const hold = useCallback((now: boolean) => {
    if (holding.current === now) return;
    holding.current = now;
    setHeld(now);
  }, []);

  const read = useCallback(() => {
    const box = pane.current;
    if (!box) return;
    if (aimed.current !== null) {
      // Landed where the app aimed it: its own move, and not an answer about
      // the reader. A move still on its way is left aimed, so the frames of a
      // smooth one do not read as him scrolling away and back again.
      if (Math.abs(box.scrollTop - aimed.current) <= 1) aimed.current = null;
      return;
    }
    hold(end(box) - box.scrollTop <= near);
  }, [pane, near, hold]);

  const quiet = useCallback(
    (move: () => void) => {
      move();
      const box = pane.current;
      if (box) aimed.current = box.scrollTop;
    },
    [pane],
  );

  const toTheEnd = useCallback(
    (how: ScrollBehavior = 'auto') => {
      const box = pane.current;
      if (!box) return;
      hold(true);
      const top = end(box);
      aimed.current = top;
      // Smooth is for the one click back to now. Everything else is instant,
      // because it happens between two frames the reader is already watching:
      // an animation there is the words he is reading sliding away from him.
      if (how === 'smooth' && typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: 'smooth' });
      else box.scrollTop = top;
    },
    [pane, hold],
  );

  // A pane opens at its end, because that is where a chat is read from — and
  // between the page being laid out and being drawn, so the history is never
  // seen flying past on the way down.
  useLayoutEffect(() => {
    toTheEnd();
  }, [toTheEnd]);

  // Where the reader is, read from the pane. A scroll is announced at most once
  // a frame by the browser itself, so there is nothing here to slow down.
  useEffect(() => {
    const box = pane.current;
    if (!box) return;
    read();
    /** From here on the pane is his, wherever the app had been aiming it. */
    const his = () => {
      aimed.current = null;
    };
    box.addEventListener('scroll', read, { passive: true });
    box.addEventListener('wheel', his, { passive: true });
    box.addEventListener('touchstart', his, { passive: true });
    box.addEventListener('keydown', his);
    return () => {
      box.removeEventListener('scroll', read);
      box.removeEventListener('wheel', his);
      box.removeEventListener('touchstart', his);
      box.removeEventListener('keydown', his);
    };
  }, [pane, read]);

  // Anything that changes how tall the conversation is, or how much of it can be
  // seen at once, keeps the end in view while the end is what he is watching: a
  // row arriving, a line still being typed, a picture that loads late, the box
  // he types in growing under it, the window resized. This is told after the
  // browser has laid the page out and before it draws it, so the pane is never
  // seen in the wrong place.
  useEffect(() => {
    const box = pane.current;
    if (!box || typeof ResizeObserver !== 'function') return;
    const grew = () => {
      if (holding.current) toTheEnd();
    };
    const watch = new ResizeObserver(grew);
    watch.observe(box);
    if (content) watch.observe(content);
    return () => watch.disconnect();
  }, [pane, content, toTheEnd]);

  const contentRef = useCallback((node: HTMLElement | null) => setContent(node), []);

  return { held, toTheEnd, quiet, contentRef };
}
