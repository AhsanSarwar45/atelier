/**
 * The picture viewer the app does not have yet: click an image, it fills the
 * screen, wheel zooms, dragging pans, Escape or the backdrop closes it. A
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

import { createPortal } from 'react-dom';
import { X, Maximize2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

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
  const [mounted, setMounted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => setMounted(true), []);

  // Every reopen (a fresh `images` array) starts fit-to-screen, not wherever
  // the last picture was left zoomed or panned to.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [images]);

  useEffect(() => {
    if (!images) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [images, onClose]);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onWheel = useCallback((e: ReactWheelEvent) => {
    e.preventDefault();
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

  if (!mounted || !images) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Picture viewer"
      className="fixed inset-0 z-50 bg-surface-base/95"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute right-3 top-3 z-10 flex gap-2">
        <Button variant="outline" size="sm" onClick={reset} aria-label="Fit to screen">
          <Maximize2 className="size-3.5" aria-hidden="true" /> Fit
        </Button>
        <Button variant="outline" size="sm" onClick={onClose} aria-label="Close">
          <X className="size-3.5" aria-hidden="true" /> Close
        </Button>
      </div>
      <div className={`flex h-full w-full ${images.length > 1 ? 'divide-x divide-b-strong' : ''}`}>
        {images.map((img, i) => (
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
      <p className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-xs text-t-primary/55">
        Scroll to zoom · drag to pan · Esc to close
      </p>
    </div>,
    document.body,
  );
}
