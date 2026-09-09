'use client';

/**
 * The bodiless anchor a right-click menu hangs off (bw-5gax.1).
 *
 * Radix hangs a menu off its trigger, and the trigger a right-click wants is
 * the pointer itself — so both of this app's pointer menus leave a bodiless
 * trigger where the press landed and let the library do the placing, the
 * flipping near an edge, the keyboard and the dismissing.
 *
 * ## Why the anchor is portalled and the content is not enough
 *
 * The press is recorded in viewport coordinates (`clientX`/`clientY`), which is
 * the only frame a pointer has. A `position: fixed` box is laid out against the
 * viewport — until an ancestor carries a `transform`, `filter`,
 * `backdrop-filter`, `perspective`, `contain: paint` or a `will-change` of any
 * of those, at which point THAT ancestor becomes the containing block and the
 * same two numbers mean something else entirely.
 *
 * The Files rail is exactly such an ancestor: it is a sheet that slides in from
 * the left on a phone, so it carries `-translate-x-full` when shut and
 * `translate-x-0` when open — and `translate-x-0` still computes to a transform
 * (`matrix(1, 0, 0, 1, 0, 0)`, which is not `none`), so the containing block
 * exists at every width and not only on a phone. Measured before this existed:
 * a right-click at y=219 opened its menu at y=307, the rail's own top edge
 * (y=96) added to every press.
 *
 * Radix already portals the menu's CONTENT, which is why the menu looked
 * plausible rather than clipped — the content was placed correctly, against an
 * anchor that was in the wrong place. So the anchor is what has to leave: a
 * React portal moves it into `document.body`, where `fixed` means the viewport
 * again, while the React tree — and therefore the Radix context the trigger
 * needs — is untouched. That is the root fix rather than an offset measured on
 * one screen: it holds for any transformed ancestor, present or future.
 */

import { useEffect, useState, type CSSProperties } from 'react';

import { createPortal } from 'react-dom';

import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** Where a press landed, in the viewport's own coordinates. */
export interface PointerAt {
  left: number;
  top: number;
}

/** A zero-sized box: it is a coordinate, not a control. */
const NOTHING: CSSProperties = { position: 'fixed', width: 0, height: 0 };

/**
 * The trigger for a menu asked for at a point, left in `document.body` so the
 * point still means what the pointer meant.
 *
 * `at` may be null while no menu is asked for; the anchor stays mounted so the
 * Radix root always has its trigger, and only its coordinates change.
 */
export function PointerAnchor({ at }: { at: PointerAt | null }) {
  // `document` does not exist while the page is being exported, and this is the
  // one thing here that needs it. Nothing is drawn until the browser has it.
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  if (!inBrowser) return null;

  return createPortal(
    <DropdownMenuTrigger
      aria-hidden="true"
      tabIndex={-1}
      data-testid="pointer-anchor"
      className="pointer-events-none"
      style={{ ...NOTHING, left: at?.left ?? 0, top: at?.top ?? 0 }}
    />,
    document.body,
  );
}
