/**
 * The picture viewer the app does not have yet: click an image, it fills the
 * screen, wheel zooms, dragging pans, Escape closes it. The window it opens in
 * is the library's own dialog wearing its full-screen shape, so the dim behind
 * the picture, the way out on Escape and the held page underneath are the same
 * ones every other popup in the app gets (bw-dks8.13). A
 * `compare` pair opens both images side by side so panning and zooming stay
 * in step between them — the same two-pane behaviour as the standalone report
 * page's lightbox (`reporting/tools/page.js`), rebuilt on CSS transforms
 * instead of its manual pixel math: `translate(ox,oy) scale(zoom)` composes
 * so a drag delta in screen pixels is the right amount to add to `ox`/`oy`
 * whatever the zoom level, so panning never needs to be re-derived per zoom
 * step. This lives here because report images are its first caller, but nothing
 * about it is report-specific — any part of the app can wrap content in
 * `LightboxProvider` and call `useLightbox().open([...])`.
 */
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import { X, Maximize2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export interface LightboxImage {
  src: string;
  caption?: string | null;
}

interface LightboxState {
  open: (images: LightboxImage[]) => void;
}

const LightboxContext = createContext<LightboxState | null>(null);

export function useLightbox(): LightboxState {
  const ctx = useContext(LightboxContext);
  if (!ctx) throw new Error('useLightbox must be used within a LightboxProvider');
  return ctx;
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [images, setImages] = useState<LightboxImage[] | null>(null);
  const open = useCallback((imgs: LightboxImage[]) => setImages(imgs), []);
  const close = useCallback(() => setImages(null), []);
  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      <LightboxOverlay images={images} onClose={close} />
    </LightboxContext.Provider>
  );
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 12;
const ZOOM_STEP = 1.15;

function LightboxOverlay({ images, onClose }: { images: LightboxImage[] | null; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);

  // The pictures have to outlive the closing: `images` is null the instant the
  // reader leaves, and the dialog is still fading out for a moment after that.
  const last = useRef<LightboxImage[]>([]);
  if (images) last.current = images;
  const shown = images ?? last.current;

  // Every reopen (a fresh `images` array) starts fit-to-screen, not wherever
  // the last picture was left zoomed or panned to.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [images]);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: ReactWheelEvent) => {
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor));
      if (next === ZOOM_MIN) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragging.current.x;
    const dy = e.clientY - dragging.current.y;
    dragging.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  return (
    <Dialog
      open={!!images}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        shape="screen"
        hideClose
        // Every other popup dims to black because its words sit in a box of
        // their own; this one's caption and hint sit straight on the dim, so it
        // takes the page's own colour and stays readable in all eleven themes.
        overlayClassName="bg-surface-base/95"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Picture viewer</DialogTitle>
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          <Button variant="outline" size="sm" onClick={reset} aria-label="Fit to screen" title="Fit to screen">
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={onClose} aria-label="Close" title="Close">
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className={`flex h-full w-full ${shown.length > 1 ? 'divide-x divide-b-strong' : ''}`}>
          {shown.map((img, i) => (
            <div
              key={i}
              className="relative h-full flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              {img.caption && (
                <p className="pointer-events-none absolute left-4 top-4 z-10 text-[11px] font-bold uppercase tracking-wide text-t-primary/75">
                  {img.caption}
                </p>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary data: URIs from the report spec, not a static app asset */}
              <img
                src={img.src}
                alt={img.caption || 'report image'}
                draggable={false}
                className="absolute inset-0 m-auto max-h-full max-w-full select-none object-contain"
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' }}
              />
            </div>
          ))}
        </div>
        <DialogDescription className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-xs">
          Scroll to zoom · drag to pan · Esc to close
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
