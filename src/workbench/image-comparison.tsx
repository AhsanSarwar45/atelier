'use client';

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ZoomIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import type { ImageComparison } from '@/workbench/protocol';
import { INLINE_MEDIA_BOUNDS } from '@/workbench/media-bounds';

/**
 * The line between the two pictures, drawn so it can be found on either.
 *
 * A single-coloured line is only ever visible on half the pictures it could be
 * drawn over: the theme's own line vanished into the dark chip strip the
 * manager was comparing, and a white one vanishes just as completely into a
 * screenshot of a white page (bw-kcri). Two tones, taken from the same pair the
 * theme already uses for a surface and the ink on it, means one of them always
 * contrasts — the core carries it on a pale picture and the outline on a dark
 * one, in either theme.
 */
const DIVIDER = 'w-0.5 bg-background ring-1 ring-foreground';

export function ImageComparisonView({ comparison, onLook }: {
  comparison: ImageComparison;
  onLook?: (comparison: ImageComparison) => void;
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
            {onLook ? <Button type="button" variant="foreground" aria-label={`Open ${image.alt} comparison to zoom`}
              className="block h-auto w-full whitespace-normal p-0" onClick={() => onLook(comparison)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.dataUrl} alt={image.alt} className="cursor-zoom-in rounded border border-border/60 object-contain transition-opacity hover:opacity-90" style={INLINE_MEDIA_BOUNDS} />
            </Button> : <img src={image.dataUrl} alt={image.alt} className="rounded border border-border/60 object-contain" style={INLINE_MEDIA_BOUNDS} />}
            <figcaption className="mt-1 text-xs text-muted-foreground">{image.alt}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  // A wipe's labels and its zoom control sit UNDER the picture, not on it.
  // Laid over it they were readable only while the picture was big enough to
  // have spare room, and a comparison is often the opposite of that: the proof
  // of a spacing change is a strip of chips a few dozen pixels tall. On the one
  // the manager was looking at, the two labels — each a whole sentence, because
  // a label here is the alt text the agent wrote — were wider than the picture
  // and hid all of it, and the round zoom button pinned to the top corner was
  // taller than the picture, so the frame's own overflow cut it in half
  // (bw-7v5c). Below it, neither can cover the picture and nothing clips them,
  // whatever shape the picture turns out to be.
  //
  // Which side is which then has to be said in words. Side by side, position
  // says it; a wipe draws both halves in one box, so the caption names them.
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
      className="relative block max-w-full select-none overflow-hidden"
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
        style={INLINE_MEDIA_BOUNDS}
        draggable={false}
      />
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={comparison.before.dataUrl} alt={comparison.before.alt} className="absolute left-0 top-0 h-full w-auto max-w-none" draggable={false} />
      </div>
      <div data-testid="comparison-divider" className={`absolute inset-y-0 cursor-ew-resize ${DIVIDER}`} style={{ left: `${pct}%` }} />
    </div>
    <div className="flex items-start gap-3 border-t border-border/60 px-2 py-1.5">
      <p data-testid="comparison-before-label" className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Before</span> {comparison.before.alt}
      </p>
      <p data-testid="comparison-after-label" className="min-w-0 flex-1 text-right text-xs text-muted-foreground">
        <span className="font-medium text-foreground">After</span> {comparison.after.alt}
      </p>
      {onLook && <Button
        variant="secondary"
        mode="icon"
        size="sm"
        radius="full"
        aria-label="Open comparison to zoom"
        className="shrink-0"
        onClick={() => onLook(comparison)}
      >
        <ZoomIn />
      </Button>}
    </div>
    </Panel>
  );
}
