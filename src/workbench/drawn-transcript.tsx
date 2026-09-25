/**
 * A bounded DOM window over the transcript.
 *
 * Storage hands this component complete forty-item pages. The virtualizer is a
 * separate bound: only rows in or near the viewport are mounted, regardless of
 * how far through history the reader has travelled. Approaching the loaded
 * head while scrolling upward asks for exactly one older page.
 */
'use client';

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

import type { Mentions } from '@/components/markdown-body';
import { NEAR, type HeldAtTheEnd } from '@/hooks/held-at-the-end';
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
  /** A message to open the chat at — one a search found — named by its id. */
  target?: string | null;
  /** Told once the chat has gone to `target`, or found it is not there. */
  onArrived?: () => void;
  /** What moves the pane: to the end, or onto a row. */
  toTheEnd: HeldAtTheEnd['toTheEnd'];
  stand: HeldAtTheEnd['stand'];
}

const rowKey = (row: DrawnRow): string => row.row === 'machine'
  ? `machine:${row.id}`
  : `${row.item.kind}:${row.item.id}`;

/** A row, and how far below the top of the pane it sits. */
interface Place {
  key: string;
  at: number;
}

/**
 * Where each chat was left, for as long as the page lives: the row at the top
 * of the pane. A chat left watching its end has no place, and nor does one
 * never opened — both open at the end.
 */
const places = new Map<string, Place>();

/**
 * The row heights each chat's rows were measured at, kept with its place. A
 * chat opened again is drawn at its real heights from the first frame, rather
 * than at guesses measured over the next few — each of which would move the
 * row it opens on.
 */
const heights = new Map<string, VirtualItem[]>();

/**
 * The topmost row that begins at or below the top of the pane: the first one
 * the reader can read a whole line of, and so the one he is holding on to.
 * Chosen by where it is and not by where it comes in the document — the
 * virtualiser reuses its rows, so the order they are written in is not the
 * order they are read in.
 *
 * How far below the top is worked out from the row's own place in the
 * conversation, which each row carries, less where the pane stands. The browser
 * would answer the same question with two rectangles, but that answer only
 * makes sense while it is read together with the pane's present position — and
 * the putting back happens frames later, when that position has moved on.
 */
function readingRow(box: HTMLElement): Place | null {
  let found: Place | null = null;
  for (const row of box.querySelectorAll<HTMLElement>('[data-transcript-key]')) {
    const key = row.dataset.transcriptKey;
    const start = Number(row.dataset.start);
    if (!key || !Number.isFinite(start)) continue;
    const at = start - box.scrollTop;
    if (at < -0.5) continue;
    if (!found || at < found.at) found = { key, at };
  }
  return found;
}

/** The rows a message id can be drawn as. */
function keysFor(target: string): string[] {
  // A chat read straight from its record names a message by the record's own
  // id; the same message replayed into this app's store carries an `acp-` in
  // front. Either finds it.
  const bare = target.replace(/^acp-/, '');
  return target.startsWith('tool:')
    ? [target, `machine:${target.slice('tool:'.length)}`]
    : [`message:${bare}`, `message:acp-${bare}`];
}

/**
 * The conversation, drawn.
 *
 * Remembered against its props, because the component that renders it also
 * holds the line being typed: without this, every character the manager types
 * redrew the whole transcript — the virtualiser measured its rows again and
 * every visible message was rebuilt — before the character itself could be
 * drawn. Typing cost the conversation rather than the word (bw-zez4).
 *
 * Every prop it is given is already stable across a keystroke: `rows` and
 * `mentions` are memoised by the parent, `pane` is a ref, `onLook` and
 * `onOlder` are held callbacks, and the rest are numbers and strings.
 */
export const DrawnTranscript = memo(function DrawnTranscript({
  rows,
  loadedItems,
  primaryItems = loadedItems,
  sessionId,
  mentions,
  onLook,
  pane,
  onOlder = null,
  target = null,
  onArrived,
  toTheEnd,
  stand,
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
  const held = useRef<Place | null>(null);
  /** How to stop holding the pane on a row, when this chat is closed. */
  const stopStanding = useRef<() => void>(() => {});
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
    initialMeasurementsCache: heights.get(sessionId),
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
    held.current = readingRow(box);
  }

  /**
   * Where a row starts, straight out of the virtualiser's measurements —
   * `getOffsetForIndex` answers a different question, rounding its answer to
   * somewhere the pane could sensibly be put. `getTotalSize` is what brings
   * those measurements up to date.
   */
  const startOf = (key: string): number | undefined => {
    virtual.getTotalSize();
    const index = latest.current.findIndex((row) => rowKey(row) === key);
    return index < 0 ? undefined : virtual.measurementsCache[index]?.start;
  };

  /** Holds a row where it is, while the rows around it are measured. */
  const standOn = (place: Place) => {
    stopStanding.current();
    stopStanding.current = stand(() => {
      const start = startOf(place.key);
      if (start === undefined) return undefined;
      // A whole position, not a distance from wherever the pane is now, so
      // asking twice leaves him in the same place. Written down as where the
      // pane last was, so the move is not read as him travelling upward,
      // which would ask for another page.
      lastTop.current = start - place.at;
      return lastTop.current;
    });
  };
  // Laid out, so it is stopped before the next chat's first place is taken.
  useLayoutEffect(
    () => () => {
      stopStanding.current();
      heights.set(sessionId, virtual.measurementsCache);
    },
    // One chat's for its whole life, like the virtualiser it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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

    // And then again until the measuring is over. The rows just put above him
    // arrive as guesses — a message is guessed at 112px and a forty-line answer
    // is five hundred — and each is measured only once it has been drawn. So
    // the row he is reading is held, by the virtualiser's own arithmetic rather
    // than by finding it on the page: at the moment the page lands he is not
    // drawn at all, and a row that is not there cannot be put back.
    standOn(anchor);
    // `standOn` reads the newest rows and measurements, not this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedItems, sessionId, pane]);

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

  // Where the reader leaves the chat is where it opens next time: the row he
  // is reading, or nowhere while he is watching the end. Laid out before the
  // next chat's first scroll, so this one never writes down that chat's place.
  useLayoutEffect(() => {
    const box = pane.current;
    if (!box) return;
    const keep = () => {
      // Hidden behind the diff, the pane has no height and no place in it.
      if (box.clientHeight === 0) return;
      const place = box.scrollHeight - box.clientHeight - box.scrollTop <= NEAR ? null : readingRow(box);
      if (place) places.set(sessionId, place);
      else places.delete(sessionId);
    };
    box.addEventListener('scroll', keep, { passive: true });
    return () => box.removeEventListener('scroll', keep);
  }, [sessionId, pane]);

  // Where the chat opens: at the message a search found, else on the row it
  // was left on, else at its end. A search's message can be far back in a long
  // chat, and so can the row it was left on, so older pages are fetched until
  // it is among the rows; looked at again whenever rows arrive, since a chat
  // that is still loading has neither its rows nor its way to older ones yet.
  const [left, setLeft] = useState(() => places.get(sessionId) ?? null);
  const goal = useMemo(
    () => (target ? { keys: keysFor(target), at: null } : left && { keys: [left.key], at: left.at }),
    [target, left],
  );
  const [found, setFound] = useState<string | null>(null);
  const [seek, setSeek] = useState<'looking' | 'found' | 'missing' | null>(null);
  const seeking = useRef<{ goal: NonNullable<typeof goal>; busy: boolean; done: boolean } | null>(null);
  const [pages, setPages] = useState(0);

  // At the end until the place it opens at is found — or for good, when it
  // has none. Before the first frame, so it is never drawn anywhere else.
  useLayoutEffect(() => {
    if (goal?.at == null) toTheEnd();
    // Once, as this chat opens: the component is one chat's for its whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!goal) {
      seeking.current = null;
      return;
    }
    if (seeking.current?.goal !== goal) {
      seeking.current = { goal, busy: false, done: false };
      setSeek('looking');
    }
    const state = seeking.current;
    if (state.done || state.busy) return;
    const arrive = (how: 'found' | 'missing') => {
      state.done = true;
      setSeek(how);
      setLeft(null);
      if (goal.at === null) onArrived?.();
      // The row it was left on is gone, so it opens where any other chat does.
      else if (how === 'missing') toTheEnd();
    };
    const row = rows.find((one) => goal.keys.includes(rowKey(one)));
    if (row) {
      const key = rowKey(row);
      // A search's message is put a third of the way down, where the eye
      // starts reading, and marked for a moment.
      const place = { key, at: goal.at ?? Math.round((pane.current?.clientHeight ?? 0) / 3) };
      places.set(sessionId, place);
      standOn(place);
      if (goal.at === null) {
        setFound(key);
        setTimeout(() => setFound((now) => (now === key ? null : now)), 6000);
      }
      arrive('found');
      return;
    }
    if (!onOlder) return;
    state.busy = true;
    void onOlder()
      .then(({ added, hasOlder }) => {
        state.busy = false;
        if (!added && !hasOlder) {
          arrive('missing');
          return;
        }
        // Look again: the rows this page added were drawn while it was still
        // marked busy, and a page already on its way added none of its own.
        setTimeout(() => seeking.current === state && setPages((n) => n + 1), added ? 0 : 60);
      })
      .catch(() => {
        state.busy = false;
        arrive('missing');
      });
    // `standOn`, `toTheEnd` and `onArrived` are read, not waited on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, rows, onOlder, pages]);

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
      data-seek={seek ?? undefined}
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
            data-found={found === rowKey(row) || undefined}
            className="absolute left-0 top-0 w-full pb-3 transition-colors data-[found]:rounded-md data-[found]:bg-amber-400/10 data-[found]:ring-1 data-[found]:ring-amber-400/40"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            {draw(row)}
          </div>
        );
      })}
    </div>
  );
});
