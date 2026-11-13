'use client';

import { useState, type ReactNode } from 'react';

import { ChevronLeft, Ellipsis } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The classes of a chip a phone hides until the status line is expanded.
 * Written out in full so Tailwind finds the variant.
 */
export const PHONE_HIDDEN = 'hidden group-data-[expanded=true]/chips:inline-flex md:inline-flex';

/**
 * The chat's status line. A phone has no room for every chip, so the less
 * urgent ones (`PHONE_HIDDEN`) wait behind a toggle that shows them all.
 */
export function ChipRow({ className, children }: { className?: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-testid="chat-status-line" data-expanded={expanded} className={cn('group/chips', className)}>
      {children}
      {/* A chip itself, so it never makes the line taller than the chips. */}
      <Badge asChild appearance="outline" size="sm" shape="circle" className="shrink-0 md:hidden">
        <Button
          variant="ghost"
          size="none"
          aria-expanded={expanded}
          aria-label={expanded ? 'Show fewer chips' : 'Show all chips'}
          title={expanded ? 'Show fewer' : 'Show all'}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? <ChevronLeft className="size-3" aria-hidden="true" /> : <Ellipsis className="size-3" aria-hidden="true" />}
        </Button>
      </Badge>
    </div>
  );
}
