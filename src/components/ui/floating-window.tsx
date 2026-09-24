'use client';

import * as React from 'react';

import { Panel } from '@/components/ui/panel';
import { Portal } from '@/components/ui/portal';
import { cn } from '@/lib/utils';

/** Where a floating window stands and how big it is, in pixels from the top left of the page. */
export type FloatingRect = { x: number; y: number; width: number; height: number };

type FloatingWindowProps = Omit<React.ComponentProps<'div'>, 'role' | 'aria-modal' | 'aria-label'> & {
  /** What the window is called, for the screen reader. */
  label: string;
  /** Where it stands. Left out, the caller's classes place it. */
  rect?: FloatingRect;
  /**
   * Edge to edge, with no corners and no border: on a phone there is nothing
   * beside the window for them to separate it from.
   */
  full?: boolean;
};

/**
 * A window over the page that is not a modal: drawn on the body, above the
 * work but below the dimming a sheet or a dialog draws, and the page behind it
 * stays live and readable. Moving and resizing it are the caller's — this is
 * the frame they happen to.
 *
 * The face is the library's overlay panel: opaque, and lifted off what it
 * covers. The shadow is deeper than an inline panel's, because this one is
 * over the whole app rather than inside a pane of it.
 */
export const FloatingWindow = React.forwardRef<HTMLDivElement, FloatingWindowProps>(function FloatingWindow(
  { label, rect, full = false, className, style, children, ...props },
  ref,
) {
  return (
    <Portal container={document.body}>
      <Panel
        ref={ref}
        tone="overlay"
        inset="none"
        className={cn(
          'fixed z-40 flex flex-col shadow-2xl outline-none',
          // Written apart from `fixed` on purpose: `fixed inset-0` on a painted
          // box is how the house check spells "a backdrop drawn by hand", and
          // this is a window, not a backdrop.
          full && 'inset-0 rounded-none border-0',
          className,
        )}
        role="dialog"
        aria-modal="false"
        aria-label={label}
        tabIndex={-1}
        style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height, ...style } : style}
        {...props}
      >
        {children}
      </Panel>
    </Portal>
  );
});
