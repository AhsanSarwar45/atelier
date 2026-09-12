import type { CSSProperties } from 'react';

import { pictureShape } from '@/workbench/picture-shape';

/** How tall a picture in the run of the conversation is allowed to get. */
const CAP = 384;

/** Natural-size chat media, capped in both dimensions so portraits stay compact. */
export const INLINE_MEDIA_BOUNDS = {
  width: 'auto',
  height: 'auto',
  maxWidth: '100%',
  maxHeight: '24rem',
} as const;

/**
 * The same bounds, with the picture's place held open from the first frame.
 *
 * `width: auto` on a picture the browser has not decoded yet is no width at
 * all, so the row is drawn flat, measured flat, and then jumps to its real
 * height a frame or two later — shoving down everything under it, which while
 * the reader is scrolling upward is him (bw-cdav.3). The bytes are already in
 * hand, so the shape is read out of the header and written into the style: the
 * width the picture would settle at, and the ratio to work its height back out
 * from. The size it ends up is the size it always was.
 *
 * A picture whose header says nothing gets the old bounds and the old jump,
 * which is no worse than before.
 */
export function inlineMediaBounds(
  /**
   * The picture, which says its own shape when it knows it. A picture kept in
   * the store has no bytes here to read a header out of, so the shape it was
   * measured at when it was attached is carried on it instead (bw-oamr.5).
   */
  image: string | { dataUrl?: string; width?: number; height?: number },
): CSSProperties {
  const given = typeof image === 'string' ? null : image;
  const shape = given?.width && given.height
    ? { width: given.width, height: given.height }
    : pictureShape(typeof image === 'string' ? image : image.dataUrl ?? '');
  if (!shape) return INLINE_MEDIA_BOUNDS;
  // Its own width, brought down if the cap on height is what binds.
  const wide = shape.height > CAP ? Math.round((shape.width * CAP) / shape.height) : shape.width;
  return {
    // A plain width with the cap beside it rather than `min()` of the two: when
    // the bubble is narrower, `max-width` brings the width down and the ratio
    // works the height back out from what is left, which is the same answer.
    width: `${wide}px`,
    height: 'auto',
    aspectRatio: `${shape.width} / ${shape.height}`,
    maxWidth: '100%',
    maxHeight: '24rem',
  };
}
