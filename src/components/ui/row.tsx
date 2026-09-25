/**
 * A line in a list that the reader can click: a search hit, a chat in a tray, a
 * command in a menu.
 *
 * The library had a button and it had a panel, and neither of them is this. A
 * <Button> is a lozenge — it centres its label, refuses to wrap it and sizes
 * itself to its words — so five screens each grew their own full-width,
 * left-aligned, hover-lit row instead, and no two of them agreed on the padding
 * or the colour they lit up (bw-dks8.10).
 *
 * `ruled` draws the hairline between one row and the next, dropped on the last
 * so a list never ends in a line with nothing under it. `selected` is the row
 * the keyboard is on, which is a different thing from the one the mouse is
 * over: both light up, and a menu being arrowed through with the pointer
 * resting on it shows the reader both answers at once, on purpose.
 *
 * `gap` lays a row out as a line of pieces — an icon, a name, a count at the
 * far end — which is what most rows are; without it the row is a plain block
 * for one span of words. `look="quiet"` is the row that heads a box of its
 * own, a tool call's line or a file in a diff: the box is already drawn, so
 * the row lifts its words rather than filling itself (bw-weih.5).
 */
import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot as SlotPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const rowVariants = cva(
  'block w-full cursor-pointer text-left transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      look: {
        fill:
          'hover:bg-accent hover:text-accent-foreground ' +
          'focus-visible:outline-hidden focus-visible:bg-accent focus-visible:text-accent-foreground ' +
          'data-[state=selected]:bg-accent data-[state=selected]:text-accent-foreground',
        // `min-h-0 min-w-0` turn a touch screen's 44px floor off, as the
        // `size="inherit"` Button this replaced did: the line keeps its
        // words' height and reaches the thumb through `data-reach="row"`
        // instead (globals.css). Without it every tool box on a phone grew
        // to the floor (bw-4cqv).
        quiet:
          'min-h-0 min-w-0 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ' +
          'data-[state=selected]:text-foreground',
        // A line in a tree of files: lit a little under the pointer and fully
        // for the open one, in the surface colours the tree sits on rather than
        // the accent a menu uses (bw-weih.9).
        tree:
          'hover:bg-surface-overlay/60 data-[state=selected]:bg-surface-overlay data-[state=selected]:hover:bg-surface-overlay',
      },
      /** The space between the pieces of a row laid out as a line. */
      gap: {
        none: '',
        sm: 'flex items-center gap-1.5',
        md: 'flex items-center gap-2',
        lg: 'flex items-center gap-3',
      },
      inset: {
        none: '',
        xs: 'px-2 py-1',
        sm: 'px-2 py-1.5',
        md: 'px-3 py-2',
        lg: 'px-4 py-3',
      },
      /** The hairline between rows, for a list that is not already spaced out. */
      ruled: {
        true: 'border-b border-border/40 last:border-b-0',
        false: '',
      },
      radius: {
        none: 'rounded-none',
        md: 'rounded-md',
      },
    },
    defaultVariants: { look: 'fill', gap: 'none', inset: 'md', ruled: false, radius: 'none' },
  },
);

const Row = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof rowVariants> & {
      /** The row the keyboard is on. */
      selected?: boolean;
      asChild?: boolean;
    }
>(function Row({ className, look, gap, inset, ruled, radius, selected, asChild = false, type, ...props }, ref) {
  const Comp = asChild ? SlotPrimitive.Slot : 'button';
  return (
    <Comp
      ref={ref}
      data-slot="row"
      // A row that is a link stays a link: `asChild` hands the paint to an <a>
      // and takes nothing away from it, which is what keeps middle-click and
      // "open in a new tab" working on a list of places to go.
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(rowVariants({ look, gap, inset, ruled, radius }), className)}
      {...(selected && { 'data-state': 'selected' })}
      {...props}
    />
  );
});
Row.displayName = 'Row';

export { Row, rowVariants };
