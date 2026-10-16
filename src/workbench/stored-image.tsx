/**
 * A picture kept in the app's media store, which may have been removed since
 * the chat showed it: a cleanup rule deletes the stored file and leaves the
 * chat's mention of it (server/src/workbench/cleanup.rs). A picture that will
 * not load is drawn as a plain box saying so, not as the browser's broken icon.
 */
'use client';

import { useState, type ComponentProps } from 'react';

import { ImageOff } from 'lucide-react';

import { cn } from '@/lib/utils';

export function StoredImage({ className, style, alt, onError, ...rest }: ComponentProps<'img'>) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <span
        role="img"
        aria-label={alt ? `${alt} (not available)` : 'Image not available'}
        data-testid="image-missing"
        className={cn(
          'flex min-h-20 items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-t-muted',
          className,
          'object-none',
        )}
        style={style}
      >
        <ImageOff className="size-4 shrink-0" aria-hidden />
        Image not available
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      alt={alt}
      className={className}
      style={style}
      onError={(event) => {
        setMissing(true);
        onError?.(event);
      }}
    />
  );
}
