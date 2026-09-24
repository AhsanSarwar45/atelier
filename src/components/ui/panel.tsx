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
import { Slot as SlotPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const panelVariants = cva('', {
  variants: {
    /**
     * `box` stands on its own, edged all round. `strip` runs the full width of
     * the pane it heads — a notice under a toolbar — so it is edged only
     * underneath, where it meets what it is about.
     */
    shape: {
      box: 'rounded-md border',
      strip: 'border-b',
    },
    tone: {
      default: 'border-border/60 bg-muted/30',
      attention: 'border-amber-500/60 bg-amber-500/10',
      /** Telling the reader something they did not ask about. */
      info: 'border-info/40 bg-info/10',
      /** What is inside is in good order and needs nothing doing to it. */
      success: 'border-success/30 bg-success/10',
      /** What is inside is wrong, and somebody has to act on it. */
      danger: 'border-danger/30 bg-danger/10',
      /** Sits above the page: opaque, and lifted off what it covers. */
      overlay: 'border-border/60 bg-background shadow-lg',
      /**
       * A border and nothing else, for a box whose contents paint themselves —
       * a table of coloured rows, a chart. A fill here would sit behind those
       * colours and flatten the difference between them (bw-dks8.10).
       */
      frame: 'border-border/60',
      /**
       * Stands out from the boxes around it: the choice the reader has made
       * among several, or the box a mock-up leads with.
       */
      accent: 'border-primary bg-primary/10',
      /**
       * A box inside another box, lifted onto the page's own colour so what it
       * holds reads against the outer box's wash rather than inside it.
       */
      nested: 'border-border/60 bg-background/50',
      /**
       * Floats over a picture: dark whatever the theme, because what is under
       * it could be any colour, so white controls on it always read.
       */
      media: 'border-white/10 bg-black/70 text-white',
    },
    inset: {
      none: '',
      /** A row of buttons, held close to its edge. */
      bar: 'p-1',
      /** One line of small print: a strip's notice. */
      xs: 'px-3 py-1',
      sm: 'px-3 py-2',
      md: 'px-3 py-3',
    },
  },
  defaultVariants: { shape: 'box', tone: 'default', inset: 'sm' },
});

export const Panel = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'> & VariantProps<typeof panelVariants> & { asChild?: boolean }>(function Panel({
  className,
  shape,
  tone,
  inset,
  asChild = false,
  ...props
}, ref) {
  // `asChild` is how a panel becomes something that is also a control: the
  // clickable report card is one box, and a <button> wrapped in a <div> would
  // be two — with the paint on the outer one and the click on the inner
  // (bw-dks8.10).
  const Comp = asChild ? SlotPrimitive.Slot : 'div';
  return <Comp ref={ref} data-slot="panel" className={cn(panelVariants({ shape, tone, inset }), className)} {...props} />;
});

export { panelVariants };
