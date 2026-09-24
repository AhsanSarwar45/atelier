'use client';

/**
 * The bodiless anchor a right-click menu hangs off (bw-5gax.1) now lives in
 * the library, beside the popover's, with the reasoning for why it is
 * portalled. This keeps the old import working until its callers move.
 */

export { PointerAnchor, type PointerAt } from '@/components/ui/point-anchor';
