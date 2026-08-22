'use client';

import { useEffect, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The shell every hand-built panel wears.
 *
 * There were five of these, each with the same three-line incantation copied
 * into it, and every one of them was built for a desktop window: a 2rem inset
 * on every side, a rounded box floating clear of the edges, and a width that
 * assumed there was width to spare. On a phone that is a box with no room in
 * it — a 390-pixel screen gives 326 to the panel and spends the rest on air.
 *
 * So: on a wide screen, unchanged — a rounded box on a dimmed page. On a phone
 * the screen IS the panel. No inset, no rounding against an edge it is already
 * flush with, and a ceiling on its height so the body scrolls inside it rather
 * than running off the bottom.
 */

/** The dimmed page behind a panel, and where the panel sits on it. */
export function Overlay({
  testId,
  label,
  className,
  onClose,
  onBackdrop,
  children,
  ...rest
}: {
  testId?: string;
  label?: string;
  /** Anything a caller needs on the backdrop itself: a darker dim, centring. */
  className?: string;
  /**
   * The way out, wired once for every panel: Escape closes it, and so does the
   * dimmed page behind it. Written here rather than copied into each panel
   * because two of the four had neither, and on a phone a panel IS the screen —
   * a reader who does not spot the small cross in the corner has no way back at
   * all (bw-81wt.18).
   */
  onClose?: () => void;
  /** Only the page behind the panel, for a panel that wants Escape left alone. */
  onBackdrop?: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | number | undefined>) {
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const backdrop = onBackdrop ?? onClose;
  return (
    <div
      data-testid={testId}
      aria-label={label}
      className={cn('fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-0 sm:p-8', className)}
      onClick={
        backdrop
          ? (e) => {
              if (e.target === e.currentTarget) backdrop();
            }
          : undefined
      }
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The panel itself: full screen on a phone, a floating box above `sm`.
 *
 * A caller adds its own `max-w-*` — how wide a panel wants to be on a desktop
 * is the panel's business — and nothing else.
 */
export const overlayPanel =
  'flex h-full max-h-full w-full flex-col overflow-hidden border-border/60 bg-background shadow-2xl ' +
  'rounded-none border-0 sm:h-auto sm:rounded-lg sm:border';
