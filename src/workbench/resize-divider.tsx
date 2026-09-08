'use client';

/**
 * The grab handle between a rail and the work beside it.
 *
 * It was written inside the chat tab, which is where the first two of them
 * live, and it is a module of its own now because the Files tab wants the same
 * handle with the same limits and the same remembered width (bw-g3o3.4). A
 * second copy would be a second minimum, a second maximum and a second set of
 * arrow-key steps, all free to drift apart while looking identical on screen.
 */

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** How wide a rail is before anybody has dragged one. */
export const DEFAULT_PANEL_WIDTH = 288;
/** Narrower than this and the rail's own rows stop being readable. */
export const MIN_PANEL_WIDTH = 208;
/** Wider than this and it is the screen rather than a rail beside one. */
export const MAX_PANEL_WIDTH = 560;

/**
 * The width remembered under `key`, or the default when nothing sensible is
 * written there. A width saved on a wider screen is brought back inside the
 * limits rather than trusted.
 */
export function rememberedPanelWidth(key: string): number {
  const width = Number(localStorage.getItem(key));
  return Number.isFinite(width) && width >= MIN_PANEL_WIDTH ? Math.min(width, MAX_PANEL_WIDTH) : DEFAULT_PANEL_WIDTH;
}

export function ResizeDivider({ side, value, onChange, maximum, onDragging }: {
  side: 'left' | 'right';
  value: number;
  onChange: (width: number) => void;
  maximum: () => number;
  onDragging?: (dragging: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (width: number) => onChange(Math.max(MIN_PANEL_WIDTH, Math.min(width, MAX_PANEL_WIDTH, maximum())));
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const distance = event.clientX - drag.current.x;
    resize(drag.current.width + (side === 'left' ? distance : -distance));
  };
  return (
    <div
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation="vertical"
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={Math.max(MIN_PANEL_WIDTH, maximum())}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      data-testid={`${side}-panel-resizer`}
      className="group relative z-40 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none md:block"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width: value };
        onDragging?.(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        drag.current = null;
        onDragging?.(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; onDragging?.(false); }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        resize(value + direction * (side === 'left' ? 16 : -16));
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-primary group-focus:bg-primary" />
    </div>
  );
}
