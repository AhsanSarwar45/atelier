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
  const previous = useRef({ sessionId, many: loadedItems });

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
    standing.current = { height: pane.current.scrollHeight, top: pane.current.scrollTop };
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
    if (!box || !stood) return;
    // Before paint, so no frame is ever drawn with the conversation shifted.
    // Nothing else is needed afterwards: rows above the fold are guessed at
    // until they are drawn, and the virtualiser puts the pane back by itself
    // the moment one of them is measured for the first time. A second, slower
    // correction of our own on top of that could only fight it.
    box.scrollTop = stood.top + (box.scrollHeight - stood.height);
    lastTop.current = box.scrollTop;
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
      setLoadingOlder(true);
      awaiting.current = true;
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
        <div data-testid="older-loading" className="absolute left-0 right-0 top-1 z-10 text-center text-xs text-muted-foreground">
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
