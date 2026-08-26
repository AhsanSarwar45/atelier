'use client';

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import type { ImageComparison, ImagePayload } from '@/workbench/protocol';

export function ImageComparisonView({ comparison, onLook }: {
  comparison: ImageComparison;
  onLook: (image: ImagePayload) => void;
}) {
  const [pct, setPct] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const place = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const box = frame.current?.getBoundingClientRect();
    if (box) setPct(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
  }, []);

  if (comparison.mode === 'side_by_side') {
    return (
      <div data-testid="image-comparison" data-mode="side_by_side" className="mb-2 grid max-w-2xl grid-cols-2 gap-2">
        {[comparison.before, comparison.after].map((image) => (
          <figure key={image.dataUrl} className="flex min-w-0 flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.dataUrl}
              alt={image.alt}
              onClick={() => onLook(image)}
              className="cursor-zoom-in rounded border border-border/60 object-contain"
              style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '24rem' }}
            />
            <figcaption className="mt-1 text-xs text-muted-foreground">{image.alt}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  return (
    <Panel tone="frame" inset="none" className="mb-2 inline-block max-w-2xl overflow-hidden align-top">
    <div
      ref={frame}
      data-testid="image-comparison"
      data-mode="wipe"
      role="slider"
      aria-label="Before and after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      tabIndex={0}
      className="relative inline-block max-w-full select-none overflow-hidden align-top"
      style={{ touchAction: 'none' }}
      onPointerDown={(event) => { dragging.current = true; frame.current?.setPointerCapture?.(event.pointerId); place(event); }}
      onPointerMove={(event) => { if (dragging.current) place(event); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerLeave={() => { dragging.current = false; }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') setPct((value) => Math.max(0, value - 2));
        if (event.key === 'ArrowRight') setPct((value) => Math.min(100, value + 2));
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={comparison.after.dataUrl}
        alt={comparison.after.alt}
        className="block object-contain"
        style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '24rem' }}
        draggable={false}
      />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={comparison.before.dataUrl} alt={comparison.before.alt} className="absolute left-0 top-0 h-full w-auto max-w-none" draggable={false} />
      </div>
      <div className="absolute inset-y-0 w-0.5 cursor-ew-resize bg-background" style={{ left: `${pct}%` }} />
      <Badge variant="outline" size="xs" className="absolute bottom-2 left-2 bg-background">{comparison.before.alt}</Badge>
      <Badge variant="outline" size="xs" className="absolute bottom-2 right-2 bg-background">{comparison.after.alt}</Badge>
    </div>
    </Panel>
  );
}
