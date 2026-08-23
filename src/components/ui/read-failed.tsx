/**
 * What a screen draws when the thing it went to fetch never came back.
 *
 * A spinner says "wait". It is the right thing to draw for as long as waiting
 * is what the reader should do — and the wrong thing the moment the answer is
 * never coming, because it asks him to wait forever and gives him nothing to do
 * about it. That is what a stuck screen was (bw-zkh4): the read had already
 * failed, and the screen was still saying wait.
 *
 * So every screen that loads something ends a failed read here instead: what
 * could not be read, in his words; what the machine said, underneath, for when
 * he wants it; and the one button that matters, which asks again.
 */
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

export function ReadFailed({
  what,
  why,
  onRetry,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** What could not be read, said as a sentence: "The board could not be read." */
  what: string;
  /** What the machine said about it, if it said anything worth showing. */
  why?: string | null;
  /** Asks again. */
  onRetry?: () => void;
  /** Anything else the reader can do from here — a way back, usually. */
  children?: React.ReactNode;
}) {
  return (
    <Panel tone="attention" role="alert" className={cn('max-w-[72ch]', className)} {...props}>
      <p className="text-sm font-semibold text-t-primary">{what}</p>
      {why && <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-t-secondary">{why}</pre>}
      {(onRetry || children) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {children}
        </div>
      )}
    </Panel>
  );
}
