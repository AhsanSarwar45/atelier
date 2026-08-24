'use client';

import { type ReactNode } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * The shell every full-page panel wears: the dim behind it, and where it sits.
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
 *
 * The dim, the way out on Escape, the held page underneath and the focus that
 * stays inside the panel are the library dialog's, not this file's: it used to
 * paint `bg-black/50` and listen for Escape itself, which is a second popup
 * mechanism living alongside the one every other window in the app uses
 * (bw-dks8.10). Nothing about it is workbench-specific, so it lives here, where
 * the paint is supposed to live.
 */
export function Overlay({
  testId,
  label,
  className,
  onClose,
  children,
  ...rest
}: {
  testId?: string;
  /** What the panel is, for a reader who cannot see it. */
  label?: string;
  /** Anything a caller needs on the sheet itself: centring, a tighter inset. */
  className?: string;
  /**
   * The way out, wired once for every panel: Escape closes it, and so does the
   * dimmed page behind it. Written here rather than copied into each panel
   * because two of the four had neither, and on a phone a panel IS the screen —
   * a reader who does not spot the small cross in the corner has no way back at
   * all (bw-81wt.18).
   */
  onClose?: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent
        shape="screen"
        hideClose
        // Half-dark, not the dialog's own near-black: what these panels cover is
        // a conversation the reader is still reading round the edges of.
        overlayClassName="bg-black/50"
        aria-describedby={undefined}
        data-testid={testId}
        className={cn('flex items-start justify-center p-0 sm:p-8', className)}
        onClick={
          onClose
            ? (e) => {
                if (e.target === e.currentTarget) onClose();
              }
            : undefined
        }
        {...rest}
      >
        {/* Said only to a screen reader: every one of these panels draws its own
            heading, and this is the one the window itself is announced by. */}
        <DialogTitle className="sr-only">{label ?? 'Panel'}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
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
