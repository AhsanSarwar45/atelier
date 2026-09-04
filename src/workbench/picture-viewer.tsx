'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent } from 'react';
import { GripVertical, Minus, Plus, RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/panel';
import type { ImageComparison, ImagePayload, LookableImage } from '@/workbench/protocol';

export interface ImageTransform {
  scale: number;
  x: number;
  y: number;
}

const RESET: ImageTransform = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function changedScale(transform: ImageTransform, by: number): ImageTransform {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale + by));
  return scale === MIN_SCALE ? RESET : { ...transform, scale };
}

function TransformLayer({ transform, children, testId }: { transform: ImageTransform; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      data-scale={transform.scale}
      data-pan-x={transform.x}
      data-pan-y={transform.y}
      className="absolute inset-0"
      style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }}
    >
      {children}
    </div>
  );
}

function ZoomViewport({ transform, onChange, children, testId }: {
  transform: ImageTransform;
  onChange: (transform: ImageTransform) => void;
  children: ReactNode;
  testId: string;
}) {
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId || transform.scale === 1) return;
    onChange({
      ...transform,
      x: drag.current.startX + event.clientX - drag.current.x,
      y: drag.current.startY + event.clientY - drag.current.y,
    });
  };
  const zoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    onChange(changedScale(transform, event.deltaY < 0 ? 0.5 : -0.5));
  };
  return (
    <div
      data-testid={testId}
      className="relative min-h-0 min-w-0 w-full flex-1 overflow-hidden rounded bg-black/30 touch-none"
      onWheel={zoom}
      onDoubleClick={() => onChange(transform.scale === 1 ? { ...RESET, scale: 2 } : RESET)}
      onPointerDown={(event) => {
        if (transform.scale === 1) return;
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: transform.x, startY: transform.y };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      {children}
    </div>
  );
}

function Controls({ transform, onChange }: { transform: ImageTransform; onChange: (transform: ImageTransform) => void }) {
  return (
    <Panel tone="overlay" inset="none" className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 gap-1 bg-black/70 p-1" data-testid="picture-zoom-controls">
      <Button variant="ghost" mode="icon" size="sm" aria-label="Zoom out" disabled={transform.scale === MIN_SCALE} className="text-white" onClick={() => onChange(changedScale(transform, -0.5))}><Minus /></Button>
      <span className="flex min-w-14 items-center justify-center text-xs text-white" data-testid="picture-zoom-level">{Math.round(transform.scale * 100)}%</span>
      <Button variant="ghost" mode="icon" size="sm" aria-label="Zoom in" disabled={transform.scale === MAX_SCALE} className="text-white" onClick={() => onChange(changedScale(transform, 0.5))}><Plus /></Button>
      <Button variant="ghost" mode="icon" size="sm" aria-label="Reset zoom and position" disabled={transform.scale === MIN_SCALE && transform.x === 0 && transform.y === 0} className="text-white" onClick={() => onChange(RESET)}><RotateCcw /></Button>
    </Panel>
  );
}

function Picture({ image, testId }: { image: ImagePayload; testId?: string }) {
  return <img data-testid={testId} src={image.dataUrl} alt={image.alt} className="pointer-events-none h-full w-full select-none object-contain" draggable={false} />;
}

function Single({ image, transform, onChange }: { image: ImagePayload; transform: ImageTransform; onChange: (value: ImageTransform) => void }) {
  return (
    <ZoomViewport transform={transform} onChange={onChange} testId="picture-zoom-viewport">
      <TransformLayer transform={transform} testId="picture-transform"><Picture image={image} testId="picture-viewer-image" /></TransformLayer>
    </ZoomViewport>
  );
}

function SideBySide({ comparison, transform, onChange }: { comparison: ImageComparison; transform: ImageTransform; onChange: (value: ImageTransform) => void }) {
  return (
    <div data-testid="picture-viewer-comparison" data-mode="side_by_side" className="grid min-h-0 w-full flex-1 grid-cols-2 gap-3">
      {[comparison.before, comparison.after].map((side, index) => (
        <figure key={side.dataUrl} className="flex min-h-0 min-w-0 flex-col gap-2">
          <ZoomViewport transform={transform} onChange={onChange} testId={`comparison-zoom-viewport-${index}`}>
            <TransformLayer transform={transform} testId={`comparison-transform-${index}`}><Picture image={side} /></TransformLayer>
          </ZoomViewport>
          <figcaption className="text-center text-sm text-white">{side.alt}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * The line between the two pictures, and the thing you take hold of to move it.
 *
 * It used to be neither: the line was `pointer-events-none` and the split was
 * moved by a bare range input sitting in the caption row below, which drew as
 * an unlabelled grey circle between the two labels. The manager could not move
 * the line and could not tell what the circle was (bw-kcri). The line is the
 * control now, which is where the hand goes anyway.
 *
 * The visible line is two pixels wide, so the strip that takes the pointer is
 * widened around it and the knob marks where to grab. `stopPropagation` on the
 * way down is what settles it against the viewport behind, which pans the
 * picture on the same gesture once it is zoomed in.
 */
function Split({ pct, onChange }: { pct: number; onChange: (value: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const place = (clientX: number) => {
    const box = strip.current?.parentElement?.getBoundingClientRect();
    if (box && box.width > 0) onChange(Math.max(0, Math.min(100, ((clientX - box.left) / box.width) * 100)));
  };
  return (
    <div
      ref={strip}
      data-testid="comparison-split"
      role="slider"
      aria-label="Before and after split"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      tabIndex={0}
      className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none justify-center"
      style={{ left: `${pct}%` }}
      onPointerDown={(event) => { event.stopPropagation(); dragging.current = true; strip.current?.setPointerCapture?.(event.pointerId); place(event.clientX); }}
      onPointerMove={(event) => { if (dragging.current) place(event.clientX); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onChange(Math.max(0, pct - 2)); }
        if (event.key === 'ArrowRight') { event.preventDefault(); onChange(Math.min(100, pct + 2)); }
      }}
    >
      <span aria-hidden className="h-full w-0.5 bg-white shadow" />
      <span aria-hidden className="absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow">
        <GripVertical className="size-4" />
      </span>
    </div>
  );
}

function Wipe({ comparison, transform, onChange }: { comparison: ImageComparison; transform: ImageTransform; onChange: (value: ImageTransform) => void }) {
  const [pct, setPct] = useState(50);
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3" data-testid="picture-viewer-comparison" data-mode="wipe">
      <ZoomViewport transform={transform} onChange={onChange} testId="comparison-zoom-viewport">
        <TransformLayer transform={transform} testId="comparison-transform-after"><Picture image={comparison.after} /></TransformLayer>
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}>
          <TransformLayer transform={transform} testId="comparison-transform-before"><Picture image={comparison.before} /></TransformLayer>
        </div>
        <Split pct={pct} onChange={setPct} />
      </ZoomViewport>
      {/* The same two columns the inline widget captions itself with, so the
          picture the reader clicked and the one that opened read alike. Full
          width: squeezed into a centred `max-w-xl` beside the old slider, two
          sentence-long labels broke into a stack of short ragged lines. */}
      <div className="flex w-full items-start gap-6 px-2 text-xs text-white">
        <p data-testid="comparison-before-label" className="min-w-0 flex-1">
          <span className="font-medium">Before</span> {comparison.before.alt}
        </p>
        <p data-testid="comparison-after-label" className="min-w-0 flex-1 text-right">
          <span className="font-medium">After</span> {comparison.after.alt}
        </p>
      </div>
    </div>
  );
}

export function PictureViewer({ image, onClose }: { image: LookableImage; onClose: () => void }) {
  const [transform, setTransform] = useState<ImageTransform>(RESET);
  const comparison: ImageComparison | null = 'mode' in image ? image : null;
  const single: ImagePayload | null = 'mode' in image ? null : image;
  const label = comparison ? `${comparison.before.alt} and ${comparison.after.alt}` : single?.alt;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent shape="screen" hideClose overlayClassName="bg-black/80" aria-describedby={undefined} aria-label={label || 'Picture'} data-testid="picture-viewer" className="flex h-full w-full flex-col items-center justify-center p-2 pt-16 sm:p-6 sm:pt-16">
        <DialogTitle className="sr-only">{label || 'Picture'}</DialogTitle>
        <Controls transform={transform} onChange={setTransform} />
        {comparison?.mode === 'side_by_side' && <SideBySide comparison={comparison} transform={transform} onChange={setTransform} />}
        {comparison?.mode === 'wipe' && <Wipe comparison={comparison} transform={transform} onChange={setTransform} />}
        {single && <Single image={single} transform={transform} onChange={setTransform} />}
        <Button variant="ghost" mode="icon" size="sm" aria-label="Close the picture" data-testid="picture-viewer-close" className="absolute right-4 top-4 z-20 text-white" onClick={onClose}><X className="h-5 w-5" /></Button>
      </DialogContent>
    </Dialog>
  );
}
