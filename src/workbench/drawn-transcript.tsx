/**
 * A bounded DOM window over the transcript.
 *
 * Storage hands this component complete forty-item pages. The virtualizer is a
 * separate bound: only rows in or near the viewport are mounted, regardless of
 * how far through history the reader has travelled. Approaching the loaded
 * head while scrolling upward asks for exactly one older page.
 */
'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';

import type { Mentions } from '@/components/markdown-body';
import type { DrawnRow } from '@/workbench/machine-lines';
import type { LookableImage } from '@/workbench/protocol';
import { MachineLine, TranscriptRow } from '@/workbench/transcript-rows';

/** Two ordinary screens of complete transcript items per storage request. */
export const SCREENFUL = 40;
/** Rows just outside the viewport, mounted before they are seen. */
export const OVERSCAN = 8;

interface DrawnTranscriptProps {
  rows: DrawnRow[];
  loadedItems: number;
  primaryItems?: number;
  sessionId: string;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
  pane: React.RefObject<HTMLElement | null>;
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
}

const rowKey = (row: DrawnRow): string => row.row === 'machine'
  ? `machine:${row.id}`
  : `${row.item.kind}:${row.item.id}`;

export function DrawnTranscript({
  rows,
  loadedItems,
  primaryItems = loadedItems,
  sessionId,
  mentions,
  onLook,
  pane,
  onOlder = null,
}: DrawnTranscriptProps) {
  const loading = useRef(false);
  const historyRequest = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastTop = useRef(0);
  /** A page has been asked for and the rows it adds have not arrived yet. */
  const awaiting = useRef(false);
  /**
   * Where the pane stood in the render that first saw the older rows, read
   * BEFORE the browser was given them.
   *
   * Read in the render body rather than when the page was asked for. A page
   * takes a while to come back and the reader goes on scrolling the whole time;
   * an anchor taken at the moment of asking says where he WAS, and putting the
   * pane back to it throws away every pixel he has scrolled since — which is
   * the jump he sees, and it is as big as the wait was long (bw-cdav.1).
   */
  const standing = useRef<{ height: number; top: number } | null>(null);
  /**
   * The row the reader's eyes are on, and how far down the pane it was, read in
   * the same render as `standing` and for the same reason.
   *
   * Putting the pane back by how much taller the conversation got is only right
   * while the rows above are the height they will end up. They are not: a row
   * arrives as a 112px guess and is measured a frame or two later at whatever
   * it really is. The virtualiser makes that good for every row that ends up
   * ABOVE the top of the pane, and deliberately does not for the row that
   * straddles it — but the reader is not reading the top of the pane, he is
   * reading a line some way down it, and everything the straddling row gains
   * pushes that line down. So the row itself is held, not the offset (bw-cdav.5).
   */
  const held = useRef<{ key: string; at: number } | null>(null);
  const settling = useRef(0);
  /** The timer that decides a page is slow enough to be worth announcing. */
  const announcing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previous = useRef({ sessionId, many: loadedItems });
  /** The newest row list, for the settling below to find its anchor in. */
  const latest = useRef(rows);
  latest.current = rows;

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => pane.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row?.row === 'other' && row.item.kind === 'message') return 112;
      if (row?.row === 'other' && (row.item.kind === 'question' || row.item.kind === 'plan')) return 180;
      return 52;
    },
    getItemKey: (index) => rowKey(rows[index]!),
    overscan: OVERSCAN,
  });

  if (previous.current.sessionId !== sessionId) {
    previous.current = { sessionId, many: loadedItems };
    historyRequest.current += 1;
    awaiting.current = false;
    standing.current = null;
    held.current = null;
    lastTop.current = 0;
    loading.current = false;
    setLoadingOlder(false);
  }

  // Read here, in the render body, because this runs BEFORE the browser is
  // given the added rows: `scrollHeight` is still the height without them and
  // `scrollTop` is wherever the reader has scrolled to by now, including
  // everything he did while the page was on its way. The layout effect below
  // runs after they are in, and the difference between the two heights is
  // exactly how much was put above him.
  if (awaiting.current && loadedItems !== previous.current.many && pane.current) {
    const box = pane.current;
    standing.current = { height: box.scrollHeight, top: box.scrollTop };
    held.current = null;
    // The topmost row that begins at or below the fold: the first one he can
    // read a whole line of, and so the one he is holding on to. Chosen by where
    // it is and not by where it comes in the document — the virtualiser reuses
    // its rows, so the order they are written in is not the order they are read
    // in, and taking the first one the document offers picks a row at random.
    //
    // How far below the fold is worked out from the row's own place in the
    // conversation, which each row carries, less where the pane stands. The
    // browser would answer the same question with two rectangles, but that
    // answer only makes sense while it is being read together with the pane's
    // present position — and the putting back below happens frames later, when
    // that position is no longer the one the answer was about.
    for (const row of box.querySelectorAll<HTMLElement>('[data-transcript-key]')) {
      const key = row.dataset.transcriptKey;
      const start = Number(row.dataset.start);
      if (!key || !Number.isFinite(start)) continue;
      const at = start - box.scrollTop;
      if (at < -0.5) continue;
      if (!held.current || at < held.current.at) held.current = { key, at };
    }
  }

  useLayoutEffect(() => {
    const box = pane.current;
    const stood = standing.current;
    // Adding older parents can collapse formerly orphaned helper rows, so the
    // drawn projection may grow or shrink even though storage was prepended.
    const changed = loadedItems !== previous.current.many;
    previous.current = { sessionId, many: loadedItems };
    if (!changed) return;
    awaiting.current = false;
    standing.current = null;
    const anchor = held.current;
    held.current = null;
    if (!box || !stood) return;
    // Before paint, so no frame is ever drawn with the conversation shifted.
    box.scrollTop = stood.top + (box.scrollHeight - stood.height);
    lastTop.current = box.scrollTop;
    if (!anchor) return;

    // And then again for a few frames, because the rows just put above him are
    // still guesses: each is measured shortly after it is drawn, and until the
    // one straddling the top of the pane has been, the line he is reading is
    // not yet where it belongs. Held to a handful of frames, and given up the
    // moment he touches the wheel himself — putting him back where he was is
    // only right for as long as he has not asked to be somewhere else.
    // And then again until the measuring is over. The rows just put above him
    // arrive as guesses — a message is guessed at 112px and a forty-line answer
    // is five hundred — and each is measured only once it has been drawn. Until
    // that has run its course the conversation above him is the wrong height,
    // and how much of that the virtualiser makes good depends on where each row
    // happens to fall relative to the fold at the moment it is measured.
    //
    // So the row he is reading is held instead, and it is held by the
    // virtualiser's own arithmetic rather than by finding it on the page: at the
    // moment the page lands he is not drawn at all — the window still being
    // shown is the one the pane was at before — and a row that is not there
    // cannot be put back.
    const until = performance.now() + 2000;
    let still = 0;
    let tall = -1;
    const done = () => {
      cancelAnimationFrame(settling.current);
      settling.current = 0;
      box.removeEventListener('wheel', done);
      box.removeEventListener('touchmove', done);
      box.removeEventListener('keydown', done);
    };
    const pin = () => {
      // Still growing means rows are still being measured, and a row measured
      // after he has been put back moves him again.
      const now = virtual.getTotalSize();
      if (now !== tall) still = 0;
      tall = now;
      const index = latest.current.findIndex((row) => rowKey(row) === anchor.key);
      // The row's own place in the conversation, straight out of the
      // virtualiser's measurements — `getOffsetForIndex` answers a different
      // question, rounding its answer to somewhere the pane could sensibly be
      // put. `getTotalSize` above is what brings those measurements up to date.
      const start = index < 0 ? undefined : virtual.measurementsCache[index]?.start;
      if (start === undefined) {
        still = 0;
      } else {
        // Where the pane has to stand for that row to sit where it sat: its
        // place in the conversation, less how far below the fold it was. A
        // whole position, not a distance to travel from wherever the pane is
        // now — so asking for it twice in two frames leaves him in the same
        // place, where adding the same shift twice took him twice as far.
        const want = start - anchor.at;
        if (Math.abs(box.scrollTop - want) > 0.5) {
          box.scrollTop = want;
          // So the scroll this causes is not read as the reader travelling
          // upward, which would ask for another page.
          lastTop.current = box.scrollTop;
          still = 0;
        } else {
          still += 1;
        }
      }
      // Finished once he has been in the right place three frames running,
      // which is the measuring being over rather than merely not started.
      if (still >= 3 || performance.now() > until) done();
      else settling.current = requestAnimationFrame(pin);
    };
    cancelAnimationFrame(settling.current);
    box.addEventListener('wheel', done, { passive: true });
    // `touchmove`, not `touchstart`. On a phone a finger landing is how every
    // scroll begins, including the one that asked for this page in the first
    // place — so giving up on `touchstart` meant the anchor was abandoned every
    // single time and the rows arriving above always jumped the reader
    // (bw-ad3r.15). A drag is the gesture that says they want to be elsewhere.
    box.addEventListener('touchmove', done, { passive: true });
    box.addEventListener('keydown', done);
    settling.current = requestAnimationFrame(pin);
    return done;
  }, [loadedItems, sessionId, pane, virtual]);

  // Loading is caused only by the reader travelling or wheeling upward.
  // A page already at scrollTop 0 cannot emit upward scroll movement, so its
  // wheel intent is the only signal available. Merely opening or laying out a
  // short page still never walks history automatically.
  useLayoutEffect(() => {
    const box = pane.current;
    if (!box) return;
    lastTop.current = box.scrollTop;
    const requestOlder = (now: number) => {
      // Keep the gesture consumed until the page it asked for has arrived. A
      // fast local response can finish before the browser emits the scroll
      // event paired with the same wheel input; without this guard that one
      // gesture asks for two pages.
      if (now > box.clientHeight || !onOlder || loading.current || awaiting.current) return;
      loading.current = true;
      const request = ++historyRequest.current;
      awaiting.current = true;
      // The notice waits, and usually never comes. A page arrives in a few tens
      // of milliseconds, and saying so every time turned scrolling back through
      // a long chat into a banner blinking on and off at every flick — which
      // read as a 'load more' control interrupting what is meant to be one
      // continuous transcript (bw-ad3r.14). It is worth showing only when the
      // wait is long enough that silence would look like nothing happening.
      clearTimeout(announcing.current);
      announcing.current = setTimeout(() => setLoadingOlder(true), 450);
      void onOlder()
        .then(({ added }) => {
          // A cursor that failed or is spent must not leave the chat waiting on
          // an unrelated live row. A page that did arrive releases this in the
          // layout effect above, once React has committed the rows it added.
          if (request === historyRequest.current && added === 0) awaiting.current = false;
        })
        .catch(() => {
          if (request === historyRequest.current) awaiting.current = false;
        })
        .finally(() => {
          if (request !== historyRequest.current) return;
          clearTimeout(announcing.current);
          loading.current = false;
          setLoadingOlder(false);
        });
    };
    const scrolled = () => {
      const now = box.scrollTop;
      const upward = now < lastTop.current - 1;
      lastTop.current = now;
      if (upward) requestOlder(now);
    };
    const wheeled = (event: WheelEvent) => {
      if (event.deltaY < 0) requestOlder(box.scrollTop);
    };
    box.addEventListener('scroll', scrolled, { passive: true });
    box.addEventListener('wheel', wheeled, { passive: true });
    return () => {
      box.removeEventListener('scroll', scrolled);
      box.removeEventListener('wheel', wheeled);
      clearTimeout(announcing.current);
    };
  }, [sessionId, pane, onOlder]);

  const draw = (row: DrawnRow) => row.row === 'machine' ? (
    <MachineLine row={row} />
  ) : (
    <TranscriptRow item={row.item} sessionId={sessionId} mentions={mentions} onLook={onLook} />
  );

  return (
    <div
      data-testid="virtual-transcript"
      data-total-items={rows.length}
      data-loaded-items={loadedItems}
      data-primary-items={primaryItems}
      data-mounted-items={virtual.getVirtualItems().length}
      data-can-load-older={Boolean(onOlder)}
      className="relative w-full"
      style={{ height: `${virtual.getTotalSize()}px` }}
    >
      {loadingOlder && (
        <div
          data-testid="older-loading"
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-0 right-0 top-1 z-10 text-center text-xs text-muted-foreground"
        >
          Loading earlier messages…
        </div>
      )}
      {virtual.getVirtualItems().map((item) => {
        const row = rows[item.index]!;
        return (
          <div
            key={item.key}
            ref={virtual.measureElement}
            data-index={item.index}
            data-start={item.start}
            data-transcript-key={rowKey(row)}
            className="absolute left-0 top-0 w-full pb-3"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {draw(row)}
          </div>
        );
      })}
    </div>
  );
}
