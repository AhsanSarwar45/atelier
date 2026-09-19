/**
 * The mark every row that names an MCP server or a plugin wears (bw-6ecp.16).
 *
 * A row used to open with its raw launch command, which says nothing about what
 * the thing is, and nothing at all to look at. Now it opens with the entry's own
 * icon where its record declares one, and a drawn mark standing for its kind
 * where it does not.
 *
 * The mark is drawn UNDERNEATH the icon rather than after it fails. A blocked or
 * slow fetch never fails — it hangs — and what that leaves on a row is an empty
 * grey box, which is worse than the mark it was supposed to replace.
 */
'use client';

import { useState } from 'react';

import { Puzzle, Server, Store } from 'lucide-react';

import { cn } from '@/lib/utils';

export type IconKind = 'server' | 'plugin' | 'marketplace';

const MARK = { server: Server, plugin: Puzzle, marketplace: Store };

export function KindIcon({ kind, src, className }: { kind: IconKind; src?: string | null; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  const Mark = MARK[kind];
  return (
    <span className={cn('relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-overlay text-t-muted', className)}>
      <Mark className="size-4" />
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className={cn('absolute inset-0 size-full rounded-md bg-surface-overlay object-contain transition-opacity', loaded ? 'opacity-100' : 'opacity-0')}
          onLoad={() => setLoaded(true)}
        />
      )}
    </span>
  );
}
