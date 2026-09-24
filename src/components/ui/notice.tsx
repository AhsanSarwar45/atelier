'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Where a lasting notice stands: the bottom corner of the window, clear of the
 * work, until the reader answers it or puts it away.
 *
 * Not a toast. A toast times out, can be swiped off, and is drawn over
 * everything, dimming included, because it is news about something the reader
 * just did. A notice like "an update is waiting" is none of those: it carries
 * its own controls and its own progress, it stays until it is answered, and
 * while a sheet is open over the page it is background — so it sits BELOW the
 * dimming a sheet or a window draws (z-30 against their z-40 and z-50), where a
 * sheet covers it whole rather than leaving a torn-off strip beside it
 * (bw-81wt.33).
 *
 * Pinned to both edges on a phone and to the right above `sm`, so its width is
 * the screen's rather than a fixed one that starts off the left edge of a
 * narrow phone. What is drawn inside it — a `Panel`, in practice — is the
 * caller's.
 */
export const Notice = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(function Notice(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="notice"
      className={cn(
        'fixed bottom-4 left-4 right-4 z-30 sm:left-auto sm:max-w-sm',
        'animate-in fade-in slide-in-from-bottom-4 duration-300',
        className,
      )}
      {...props}
    />
  );
});
