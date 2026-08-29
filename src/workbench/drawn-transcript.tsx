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
  sessionId: string;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
  pane: React.RefObject<HTMLElement | null>;
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
}

const rowKey = (row: DrawnRow): string => row.row === 'machine'
  ? `machine:${row.id}`
  : `${row.item.kind}:${row.item.id}`;

export function DrawnTranscript({ rows, sessionId, mentions, onLook, pane, onOlder = null }: DrawnTranscriptProps) {
  const loading = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastTop = useRef(0);
  const pendingAnchor = useRef<{ height: number; top: number; key: string | null; viewportTop: number } | null>(null);
  const correcting = useRef<number | null>(null);
  const previous = useRef({ sessionId, many: rows.length });

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
    previous.current = { sessionId, many: rows.length };
    pendingAnchor.current = null;
    if (correcting.current !== null) cancelAnimationFrame(correcting.current);
    correcting.current = null;
    lastTop.current = 0;
    loading.current = false;
  }

  useLayoutEffect(() => {
    const box = pane.current;
    const anchor = pendingAnchor.current;
    const grew = rows.length > previous.current.many;
    previous.current = { sessionId, many: rows.length };
    if (!box || !anchor || !grew) return;
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
  }, [rows.length, sessionId, pane]);

  // Loading is caused only by an upward scroll. Merely opening a chat or
  // laying out a short page never walks its history automatically.
  useLayoutEffect(() => {
    const box = pane.current;
    if (!box) return;
    lastTop.current = box.scrollTop;
    const scrolled = () => {
      const now = box.scrollTop;
      const upward = now < lastTop.current - 1;
      lastTop.current = now;
      if (!upward || now > box.clientHeight || !onOlder || loading.current) return;
      loading.current = true;
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
          if (added === 0) pendingAnchor.current = null;
        })
        .catch(() => {
          pendingAnchor.current = null;
        })
        .finally(() => {
          loading.current = false;
          setLoadingOlder(false);
        });
    };
    box.addEventListener('scroll', scrolled, { passive: true });
    return () => box.removeEventListener('scroll', scrolled);
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
      data-mounted-items={virtual.getVirtualItems().length}
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
