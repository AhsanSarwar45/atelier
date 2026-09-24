'use client';

/**
 * A menu or a popover opened at a point rather than at a control: the pointer's
 * right-click (bw-5gax.1), or the box around some selected text that a "Copy
 * text" offer hangs off.
 *
 * Radix hangs a menu off its trigger and a popover off its anchor, so both
 * leave a bodiless one where the point is and let the library do the placing,
 * the flipping near an edge, the keyboard and the dismissing.
 *
 * ## Why the anchor is portalled and the content is not enough
 *
 * The point is recorded in viewport coordinates (`clientX`/`clientY`, or a
 * selection's `getBoundingClientRect()`), which is the only frame a pointer
 * has. A `position: fixed` box is laid out against the viewport — until an
 * ancestor carries a `transform`, `filter`, `backdrop-filter`, `perspective`,
 * `contain: paint` or a `will-change` of any of those, at which point THAT
 * ancestor becomes the containing block and the same two numbers mean
 * something else entirely.
 *
 * The Files rail is exactly such an ancestor: it is a sheet that slides in from
 * the left on a phone, so it carries `-translate-x-full` when shut and
 * `translate-x-0` when open — and `translate-x-0` still computes to a transform
 * (`matrix(1, 0, 0, 1, 0, 0)`, which is not `none`), so the containing block
 * exists at every width and not only on a phone. Measured before this existed:
 * a right-click at y=219 opened its menu at y=307, the rail's own top edge
 * (y=96) added to every press. The hand-placed "Copy text" boxes in the file
 * viewer and the diff table are `fixed` boxes of the same kind.
 *
 * Radix already portals the CONTENT, which is why a menu looked plausible
 * rather than clipped — the content was placed correctly, against an anchor
 * that was in the wrong place. So the anchor is what has to leave: a React
 * portal moves it into `document.body`, where `fixed` means the viewport again,
 * while the React tree — and therefore the Radix context the anchor needs — is
 * untouched. That is the root fix rather than an offset measured on one
 * screen: it holds for any transformed ancestor, present or future.
 */

import * as React from 'react';

import { createPortal } from 'react-dom';

import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PopoverAnchor } from '@/components/ui/popover';

/** Where a press landed, in the viewport's own coordinates. */
export interface PointerAt {
  left: number;
  top: number;
  /** A box rather than a point — a selection's rectangle. Zero when absent. */
  width?: number;
  height?: number;
}

/**
 * The anchor's own box: the point, or the rectangle, and nothing to see. A
 * rectangle lets the content sit beside the whole selection rather than off
 * one corner of it.
 */
function box(at: PointerAt | null): React.CSSProperties {
  return {
    position: 'fixed',
    left: at?.left ?? 0,
    top: at?.top ?? 0,
    width: at?.width ?? 0,
    height: at?.height ?? 0,
  };
}

/** `document` does not exist while the page is being exported. */
function useInBrowser() {
  const [inBrowser, setInBrowser] = React.useState(false);
  React.useEffect(() => setInBrowser(true), []);
  return inBrowser;
}

/**
 * The trigger for a `DropdownMenu` asked for at a point, left in
 * `document.body` so the point still means what the pointer meant.
 *
 * `at` may be null while no menu is asked for; the anchor stays mounted so the
 * Radix root always has its trigger, and only its coordinates change.
 */
export function PointerAnchor({ at }: { at: PointerAt | null }) {
  if (!useInBrowser()) return null;
  return createPortal(
    <DropdownMenuTrigger
      aria-hidden="true"
      tabIndex={-1}
      data-testid="pointer-anchor"
      className="pointer-events-none"
      style={box(at)}
    />,
    document.body,
  );
}

/**
 * The same, for a `Popover`: `<Popover open><PopoverAtPoint at={rect} />
 * <PopoverContent>…`. The popover is opened by whoever knows there is a point
 * to open it at, so this is an anchor and not a trigger.
 */
export function PopoverAtPoint({ at }: { at: PointerAt | null }) {
  if (!useInBrowser()) return null;
  return createPortal(
    <PopoverAnchor
      aria-hidden="true"
      data-testid="popover-point-anchor"
      className="pointer-events-none"
      style={box(at)}
    />,
    document.body,
  );
}
