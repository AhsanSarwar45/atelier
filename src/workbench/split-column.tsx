'use client';

/**
 * Two panes, one above the other, with a divider a person can move.
 *
 * The Git rail was one scrolling column: the branch header, every changed
 * file, the message box, the Commit button and the whole history shared a
 * single scroll. Forty changed files pushed the message box and the button off
 * the bottom, so the one action the panel exists for could not be reached
 * without scrolling past the thing you were about to describe (bw-g6zy.3).
 *
 * Splitting it needs no measuring. Both panes are `flex-basis: 0` and grow by
 * their share, so the browser does the arithmetic and a resize of the window
 * needs no code here at all. The container's height is read once, at the
 * moment a drag starts, only to turn the pointer's travel into a share.
 *
 * Each pane keeps a floor, so neither can be dragged out of existence: a
 * divider you cannot find again is a divider that has eaten a pane.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

/** The smallest a pane may be dragged to, in pixels. */
const LEAST = 88;

/** Where the divider sits before anyone has moved it: two thirds, one third. */
export const TWO_THIRDS = 2 / 3;

/** How far an arrow key moves the divider. */
const NUDGE = 0.02;

/** Never all the way to either end, whatever the floors work out to. */
function sane(fraction: number): number {
  if (!Number.isFinite(fraction)) return TWO_THIRDS;
  return Math.min(0.9, Math.max(0.1, fraction));
}

function remembered(key: string | undefined): number {
  if (!key || typeof window === 'undefined') return TWO_THIRDS;
  try {
    const kept = window.localStorage.getItem(`split-column:${key}`);
    return kept === null ? TWO_THIRDS : sane(Number.parseFloat(kept));
  } catch {
    // A browser with storage switched off is a browser that opens on the
    // default every time, which is a smaller loss than not opening.
    return TWO_THIRDS;
  }
}

export interface SplitColumnProps {
  /** The pane above the divider. */
  top: React.ReactNode;
  /** The pane below it. */
  bottom: React.ReactNode;
  /**
   * What to file the divider's position under. Left out, the split opens
   * where it always opens and forgets where it was left.
   */
  storageKey?: string;
  /** What the divider is called, for a person moving it by keyboard. */
  label?: string;
  className?: string;
}

export function SplitColumn({
  top,
  bottom,
  storageKey,
  label = 'Resize',
  className,
}: SplitColumnProps) {
  const holder = React.useRef<HTMLDivElement>(null);
  const [share, setShare] = React.useState(TWO_THIRDS);
  const [dragging, setDragging] = React.useState(false);

  // Read on the client and not in the initial state, so the server and the
  // first paint agree and React has nothing to complain about.
  React.useEffect(() => {
    setShare(remembered(storageKey));
  }, [storageKey]);

  const settle = React.useCallback(
    (next: number) => {
      const kept = sane(next);
      setShare(kept);
      if (!storageKey || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(`split-column:${storageKey}`, kept.toFixed(4));
      } catch {
        // Nothing to do and nothing worth saying: the divider still moved.
      }
    },
    [storageKey],
  );

  const moveTo = React.useCallback(
    (y: number) => {
      const box = holder.current?.getBoundingClientRect();
      if (!box || box.height <= 0) return;
      const floor = LEAST / box.height;
      const asked = (y - box.top) / box.height;
      settle(Math.min(1 - floor, Math.max(floor, asked)));
    },
    [settle],
  );

  const grab = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Capture keeps the drag alive when the pointer outruns a three-pixel
    // bar, which it will. Asked for rather than assumed: it is missing from
    // jsdom, and a divider that throws on mousedown under test is worse than
    // one that simply drags a little less smoothly there.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    moveTo(event.clientY);
  };

  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const typed = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const floor = LEAST / (holder.current?.getBoundingClientRect().height || 1);
    const moves: Record<string, number | undefined> = {
      ArrowUp: share - NUDGE,
      ArrowDown: share + NUDGE,
      Home: floor,
      End: 1 - floor,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    settle(next);
  };

  return (
    <div ref={holder} className={cn('flex min-h-0 flex-1 flex-col', className)} data-testid="split-column">
      <div
        className="flex min-h-0 flex-col"
        style={{ flexGrow: share, flexBasis: 0, minHeight: LEAST }}
        data-testid="split-top"
      >
        {top}
      </div>
      {/* The bar itself is two pixels of line inside a taller reach: a divider
          you have to hit exactly is a divider nobody moves. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={10}
        aria-valuemax={90}
        tabIndex={0}
        data-testid="split-handle"
        data-dragging={dragging || undefined}
        className={cn(
          'group relative z-10 -my-1 flex h-3 shrink-0 cursor-row-resize touch-none items-center',
          'focus-visible:outline-none',
        )}
        onPointerDown={grab}
        onPointerMove={drag}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={typed}
      >
        <div
          className={cn(
            'h-px w-full bg-border transition-colors',
            'group-hover:h-0.5 group-hover:bg-border-strong',
            'group-focus-visible:h-0.5 group-focus-visible:bg-ring',
            'group-data-[dragging]:h-0.5 group-data-[dragging]:bg-ring',
          )}
          aria-hidden="true"
        />
      </div>
      <div
        className="flex min-h-0 flex-col"
        style={{ flexGrow: 1 - share, flexBasis: 0, minHeight: LEAST }}
        data-testid="split-bottom"
      >
        {bottom}
      </div>
    </div>
  );
}
