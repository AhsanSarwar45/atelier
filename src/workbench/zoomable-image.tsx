'use client';

/**
 * One picture that opens full size: the chat's `image` widget, and every
 * single picture a task card or a grid cell shows (a before and after pair is
 * `ImageComparisonView`'s). One implementation, so a picture looks and behaves
 * the same wherever it is drawn: a zoom badge in its corner, "Open full size"
 * on hover, the full-screen viewer on a click, and a plain box saying so when
 * the picture is gone (a cleanup rule removed the stored file).
 */
import { useState } from 'react';

import { ZoomIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PictureViewer } from '@/workbench/picture-viewer';
import { StoredImage } from '@/workbench/stored-image';

/**
 * In a task card or a grid cell a picture sits among lines of text, so it is
 * kept to their scale: its own width, at most 12rem tall, framed like the
 * other pictures there. A click still opens it full screen.
 */
const COMPACT_BUTTON = 'inline-block w-auto max-w-full align-top';
const COMPACT_IMAGE = 'max-h-48 w-auto rounded border border-border/60';

export function ZoomableImage({ src, alt, caption, className, compact = false }: {
  src: string;
  alt: string;
  /** Shown under the picture. */
  caption?: string;
  /** The figure around the picture. */
  className?: string;
  /** Kept small, for a card or a cell rather than a chat message. */
  compact?: boolean;
}) {
  const [looking, setLooking] = useState(false);
  // A picture a cleanup rule removed has nothing to open full size.
  const [gone, setGone] = useState(false);
  return (
    <figure className={className} data-testid="zoomable-image">
      {gone ? (
        <StoredImage src={src} alt={alt} className="w-full" />
      ) : (
        <Tooltip label="Open full size">
          <Button type="button" variant="foreground" aria-label={`Open ${alt} to zoom`} size="none"
            className={cn('group relative block w-full whitespace-normal', compact && COMPACT_BUTTON)} onClick={() => setLooking(true)}>
            <StoredImage src={src} alt={alt} onError={() => setGone(true)}
              className={cn('max-h-[38rem] w-full cursor-zoom-in rounded-md object-contain transition-opacity group-hover:opacity-90', compact && COMPACT_IMAGE)} />
            <span aria-hidden className="absolute right-2 top-2 rounded-full bg-background/90 p-2 shadow"><ZoomIn className="size-4" /></span>
          </Button>
        </Tooltip>
      )}
      {caption && <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>}
      {looking && <PictureViewer image={{ mime: 'image/*', dataUrl: src, alt }} onClose={() => setLooking(false)} />}
    </figure>
  );
}
