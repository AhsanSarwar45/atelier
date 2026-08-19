/**
 * Before and after, one picture over the other, split by a handle the reader
 * drags — `page.js`'s `.wipe` slider. The "after" image fills the frame; the
 * "before" image sits on top, clipped to `pct`% width, so dragging right
 * uncovers more of "before" and dragging left uncovers more of "after".
 * Starts at the midpoint, same as the reference.
 */
'use client';

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Badge } from '@/components/ui/badge';

import type { WipeBlock } from '../types';

export function WipeBlockView({ block }: { block: WipeBlock }) {
  const [pct, setPct] = useState(50);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fromEvent = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setPct(Math.max(0, Math.min(100, (x / rect.width) * 100)));
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      dragging.current = true;
      ref.current?.setPointerCapture?.(e.pointerId);
      fromEvent(e);
    },
    [fromEvent],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragging.current) fromEvent(e);
    },
    [fromEvent],
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const beforeCaption = block.before.caption ?? 'Before';
  const afterCaption = block.after.caption ?? 'After';

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Before and after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      tabIndex={0}
      style={{ touchAction: 'none' }}
      className="relative select-none overflow-hidden rounded-md"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setPct((p) => Math.max(0, p - 2));
        if (e.key === 'ArrowRight') setPct((p) => Math.min(100, p + 2));
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary data: URI from the report spec */}
      <img src={block.after.src} alt={afterCaption} className="block w-full" draggable={false} />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary data: URI from the report spec */}
        <img
          src={block.before.src}
          alt={beforeCaption}
          draggable={false}
          className="absolute left-0 top-0 h-full w-auto max-w-none"
        />
      </div>
      <div
        className="absolute inset-y-0 w-0.5 cursor-ew-resize bg-surface-base"
        style={{ left: `${pct}%` }}
      >
        <div className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-info bg-surface-base" />
      </div>
      <Badge
        variant="outline"
        size="xs"
        className="absolute bottom-2 left-2 bg-surface-base font-bold uppercase tracking-wide text-t-secondary"
      >
        {beforeCaption}
      </Badge>
      <Badge
        variant="outline"
        size="xs"
        className="absolute bottom-2 right-2 bg-surface-base font-bold uppercase tracking-wide text-t-secondary"
      >
        {afterCaption}
      </Badge>
    </div>
  );
}
