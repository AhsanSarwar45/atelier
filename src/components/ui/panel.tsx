/**
 * A boxed piece of content: the frame every card, tray and inline panel uses,
 * so they agree on their border, their rounding and their inset.
 *
 * `tone` is what the box means, never how it looks — "attention" is a box that
 * is asking for something, and it is the theme's warning colour wherever it is
 * drawn.
 */
import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const panelVariants = cva('rounded-md border', {
  variants: {
    tone: {
      default: 'border-border/60 bg-muted/30',
      attention: 'border-amber-500/60 bg-amber-500/10',
      /** Telling the reader something they did not ask about. */
      info: 'border-info/40 bg-info/10',
      /** Sits above the page: opaque, and lifted off what it covers. */
      overlay: 'border-border/60 bg-background shadow-lg',
    },
    inset: {
      none: '',
      sm: 'px-3 py-2',
      md: 'px-3 py-3',
    },
  },
  defaultVariants: { tone: 'default', inset: 'sm' },
});

export function Panel({
  className,
  tone,
  inset,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof panelVariants>) {
  return <div data-slot="panel" className={cn(panelVariants({ tone, inset }), className)} {...props} />;
}

export { panelVariants };
