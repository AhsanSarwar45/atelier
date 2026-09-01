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
  sessionId: string;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
  pane: React.RefObject<HTMLElement | null>;
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
}

const rowKey = (row: DrawnRow): string => row.row === 'machine'
  ? `machine:${row.id}`
  : `${row.item.kind}:${row.item.id}`;

export function DrawnTranscript({ rows, loadedItems, sessionId, mentions, onLook, pane, onOlder = null }: DrawnTranscriptProps) {
  const loading = useRef(false);
  const historyRequest = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastTop = useRef(0);
  const pendingAnchor = useRef<{ height: number; top: number; key: string | null; viewportTop: number } | null>(null);
  const correcting = useRef<number | null>(null);
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

  useLayoutEffect(() => () => {
    if (correcting.current !== null) cancelAnimationFrame(correcting.current);
  }, []);

  if (previous.current.sessionId !== sessionId) {
    previous.current = { sessionId, many: loadedItems };
    historyRequest.current += 1;
    pendingAnchor.current = null;
    if (correcting.current !== null) cancelAnimationFrame(correcting.current);
    correcting.current = null;
    lastTop.current = 0;
    loading.current = false;
    setLoadingOlder(false);
  }

  useLayoutEffect(() => {
    const box = pane.current;
    const anchor = pendingAnchor.current;
    // Adding older parents can collapse formerly orphaned helper rows, so the
    // drawn projection may grow or shrink even though storage was prepended.
    const changed = loadedItems !== previous.current.many;
    previous.current = { sessionId, many: loadedItems };
    if (!box || !anchor || !changed) return;
    box.scrollTop = anchor.top + (box.scrollHeight - anchor.height);
    lastTop.current = box.scrollTop;
    // The first correction uses the virtual height estimate and happens before
    // paint. Dynamic rows are measured just after that; keep the exact DOM row
    // the reader was looking at pinned through those measurements too.
    let passes = 0;
    const correct = () => {
      const key = anchor.key;
      const row = key === null ? null : Array.from(box.querySelectorAll<HTMLElement>('[data-transcript-key]'))
        .find((element) => element.dataset.transcriptKey === key) ?? null;
      if (row) {
        box.scrollTop += row.getBoundingClientRect().top - anchor.viewportTop;
        lastTop.current = box.scrollTop;
      }
      passes += 1;
      if (passes < 3 && typeof requestAnimationFrame === 'function') {
        correcting.current = requestAnimationFrame(correct);
      } else {
        correcting.current = null;
        pendingAnchor.current = null;
      }
    };
    if (typeof requestAnimationFrame === 'function') correcting.current = requestAnimationFrame(correct);
    else pendingAnchor.current = null;
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
      // Keep the gesture consumed until its prepend anchor has settled. A
      // fast local response can finish before the browser emits the scroll
      // event paired with the same wheel input; without the anchor guard that
      // one gesture asks for two pages.
      if (now > box.clientHeight || !onOlder || loading.current || pendingAnchor.current) return;
      loading.current = true;
      const request = ++historyRequest.current;
      setLoadingOlder(true);
      const paneTop = box.getBoundingClientRect().top;
      const anchor = Array.from(box.querySelectorAll<HTMLElement>('[data-transcript-key]')).find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > paneTop;
      });
      pendingAnchor.current = {
        height: box.scrollHeight,
        top: now,
        key: anchor?.dataset.transcriptKey ?? null,
        viewportTop: anchor?.getBoundingClientRect().top ?? paneTop,
      };
      void onOlder()
        .then(({ added }) => {
          // A failed or exhausted cursor must not leave an anchor waiting for
          // an unrelated live row. A successful prepend consumes it in the
          // layout effect above, after React has committed the added rows.
          if (request === historyRequest.current && added === 0) pendingAnchor.current = null;
        })
        .catch(() => {
          if (request === historyRequest.current) pendingAnchor.current = null;
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
