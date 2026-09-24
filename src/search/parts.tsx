/**
 * The pieces a search draws with, so a chat, a card and a file read the same
 * and fit a phone as well as a desktop (bw-ac7z.1).
 *
 * On a phone a found thing's facts go under its name rather than beside it,
 * and the label of the words that matched goes above them rather than in a
 * column of its own: at 390 pixels a column beside the words leaves them a
 * third of the screen, and a name beside its facts ends after two words.
 */
'use client';

import { type ComponentProps, forwardRef, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** How far a place inside a found thing sits in from its head. */
export const PLACE = 'py-1.5 pl-4 sm:pl-8';

/** What a found thing is called: whole on a phone, cut to one line on a desktop. */
export const TITLE = 'min-w-0 break-words text-sm font-medium text-foreground sm:truncate';

/** A found thing's first line: its name, then its facts. */
export function Heading({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <div className="flex min-w-0 items-baseline gap-2 sm:flex-1">{title}</div>
      {meta && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground sm:shrink-0 sm:flex-nowrap">
          {meta}
        </div>
      )}
    </div>
  );
}

/** The words that matched, under who or what said them. */
export function Excerpt({ label, mono, children }: { label: ReactNode; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col text-sm sm:flex-row sm:gap-2">
      <span className="shrink-0 truncate text-[11px] leading-5 text-muted-foreground sm:w-20">{label}</span>
      <span className={cn('min-w-0 break-words text-foreground/90', mono && 'font-mono text-xs leading-5')}>{children}</span>
    </div>
  );
}

/**
 * The box a search or a question is typed into, with what it does drawn inside
 * it. The library's field does the drawing; this only fixes the size of the
 * words and lets the box take the room its row leaves it.
 */
export const QueryBox = forwardRef<HTMLInputElement, ComponentProps<typeof Input> & { icon: ReactNode }>(function QueryBox(
  { icon, className, containerClassName, ...props },
  ref,
) {
  return (
    <Input
      ref={ref}
      start={icon}
      containerClassName={cn('flex-1', containerClassName)}
      className={cn('text-sm', className)}
      {...props}
    />
  );
});
