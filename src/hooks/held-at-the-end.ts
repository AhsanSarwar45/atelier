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
 * to hold his place when older messages arrive above him. Those moves are
 * AIMED, and a move that lands where it was aimed says nothing about him. A
 * move that lands anywhere else is his, whatever put it there — which is what
 * makes dragging the scrollbar, where there is no wheel and no key to listen
 * for, read as the reader taking the pane over.
 *
 * The pane arrives late. A chat draws its own 'pick a project' line first and
 * the scrolling pane only once it knows which conversation it is showing, so
 * everything here waits on the node itself rather than on the first render:
 * `paneRef` is what says the pane now exists. Reading a ref in an effect that
 * runs once left this hook listening to nothing at all, and a reader who
 * scrolled up was never noticed — the whole point of it, silently dead.
 */

/** How far from the end still counts as watching it. */
const NEAR = 64;

export interface HeldAtTheEnd {
  /** Whether the end of the pane is what the reader is watching. */
  held: boolean;
  /** Put the end back in view, and follow it again. */
  toTheEnd: (how?: ScrollBehavior) => void;
  /** Goes on the pane that scrolls. */
  paneRef: (node: HTMLElement | null) => void;
  /** Goes on the box holding the rows, so what it does to its own height is noticed. */
  contentRef: (node: HTMLElement | null) => void;
}

/** What the pane would have to be scrolled to for its end to be in view. */
function end(box: HTMLElement): number {
  return box.scrollHeight - box.clientHeight;
}

export function useHeldAtTheEnd(pane: React.MutableRefObject<HTMLElement | null>, near = NEAR): HeldAtTheEnd {
  const [held, setHeld] = useState(true);
  /** The same answer, readable from a listener that must not be torn down to see it. */
  const holding = useRef(true);
  /** Where the app last aimed the pane, or nothing while the pane is the reader's. */
  const aimed = useRef<number | null>(null);
  /** A smooth move still on its way, whose frames are not the reader scrolling. */
  const gliding = useRef(false);
  /** Where the pane was left standing, and how far its end was then. */
  const left = useRef({ top: 0, end: 0 });
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);

  const hold = useCallback((now: boolean) => {
    if (holding.current === now) return;
    holding.current = now;
    setHeld(now);
  }, []);

  const toTheEnd = useCallback(
    (how: ScrollBehavior = 'auto') => {
      const there = pane.current;
      if (!there) return;
      hold(true);
      const top = end(there);
      aimed.current = top;
      left.current = { top, end: top };
      // Smooth is for the one click back to now. Everything else is instant,
      // because it happens between two frames the reader is already watching:
      // an animation there is the words he is reading sliding away from him.
      if (how === 'smooth' && typeof there.scrollTo === 'function') {
        gliding.current = true;
        // Taking hold changes the page under the move: the way back gives up
        // its own strip of screen as it goes, which makes the pane taller and
        // its end that much nearer. Aim once the browser has laid that out, or
        // the move is aimed past anywhere the pane can go and never arrives.
        requestAnimationFrame(() => {
          const there2 = pane.current;
          if (!there2 || !gliding.current) return;
          const now = end(there2);
          aimed.current = now;
          left.current = { top: now, end: now };
          there2.scrollTo({ top: now, behavior: 'smooth' });
        });
      } else {
        there.scrollTop = top;
      }
    },
    [pane, hold],
  );

  const read = useCallback(() => {
    if (!box) return;
    const now = { top: box.scrollTop, end: end(box) };
    // Where it was aimed, or as far as the pane can go — a move aimed at an
    // end that has come nearer since is over when the pane runs out of room,
    // and waiting for an exact arrival that can never happen would leave the
    // chat gliding for ever and following nothing.
    const landed =
      (aimed.current !== null && Math.abs(now.top - aimed.current) <= 1) || now.top >= now.end - 1;
    // A smooth move is a hundred frames of the pane being somewhere it was not
    // aimed. None of them is the reader, and only the arrival ends it.
    if (gliding.current && !landed) return;
    aimed.current = null;
    if (landed) {
      gliding.current = false;
      left.current = now;
      // Wherever it came from, the pane is at the end: that is what watching
      // the end means, whether the app put it there or he scrolled back to it.
      hold(true);
      // A smooth move is aimed at the end as it stood when it set off, and the
      // conversation goes on growing under it — a word arriving, or the way
      // back giving its own strip of screen up as it leaves. Whatever the end
      // is now is where he asked to be.
      if (holding.current && now.end - now.top > 1) toTheEnd();
      return;
    }
    // The pane exactly where it was left, inside a box that is no longer the
    // same size: the window was resized, or something grew under the
    // conversation. The distance to the end changed without him doing anything,
    // and reading that distance as an answer let a resized window quietly stop
    // a chat following its own end.
    if (Math.abs(now.top - left.current.top) <= 1 && now.end !== left.current.end) {
      if (holding.current) {
        toTheEnd();
        return;
      }
      left.current = now;
      return;
    }
    left.current = now;
    hold(now.end - now.top <= near);
  }, [box, near, hold, toTheEnd]);

  // Before every frame the chat draws, while the end is what he is watching.
  // The conversation arrives a piece at a time and each piece is a render, so
  // the end has to be put back between the browser laying the page out and
  // painting it — a pane pinned after the paint is a page seen at the top of a
  // conversation for one frame, on every open.
  useLayoutEffect(() => {
    if (box && holding.current && !gliding.current) toTheEnd();
  });

  // Where the reader is, read from the pane. A scroll is announced at most once
  // a frame by the browser itself, so there is nothing here to slow down.
  useEffect(() => {
    if (!box) return;
    read();
    /** From here on the pane is his, wherever the app had been aiming it. */
    const his = () => {
      aimed.current = null;
      gliding.current = false;
    };
    // At scrollTop 0 an upward wheel may have nowhere to move until the older
    // page arrives. The absence of a scroll event does not mean the reader is
    // still following the newest row: the gesture itself is the decision to
    // read history. Releasing here prevents that prepend being pulled straight
    // back to the bottom by the layout effect above.
    const wheeled = (event: WheelEvent) => {
      his();
      if (event.deltaY < 0) hold(false);
    };
    const keyed = (event: KeyboardEvent) => {
      his();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) hold(false);
    };
    box.addEventListener('scroll', read, { passive: true });
    box.addEventListener('wheel', wheeled, { passive: true });
    box.addEventListener('touchstart', his, { passive: true });
    box.addEventListener('keydown', keyed);
    return () => {
      box.removeEventListener('scroll', read);
      box.removeEventListener('wheel', wheeled);
      box.removeEventListener('touchstart', his);
      box.removeEventListener('keydown', keyed);
    };
  }, [box, hold, read]);

  // Anything that changes how tall the conversation is, or how much of it can be
  // seen at once, without the chat drawing a frame of its own: a picture that
  // loads late, the box he types in growing under it, the window resized.
  useEffect(() => {
    if (!box || typeof ResizeObserver !== 'function') return;
    const grew = () => {
      if (holding.current && !gliding.current) toTheEnd();
    };
    const watch = new ResizeObserver(grew);
    watch.observe(box);
    if (content) watch.observe(content);
    return () => watch.disconnect();
  }, [box, content, toTheEnd]);

  const paneRef = useCallback(
    (node: HTMLElement | null) => {
      pane.current = node;
      setBox(node);
    },
    [pane],
  );
  const contentRef = useCallback((node: HTMLElement | null) => setContent(node), []);

  return { held, toTheEnd, paneRef, contentRef };
}
