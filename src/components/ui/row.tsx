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
 */
import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot as SlotPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

const rowVariants = cva(
  'block w-full cursor-pointer text-left transition-colors hover:bg-accent hover:text-accent-foreground ' +
    'focus-visible:outline-hidden focus-visible:bg-accent focus-visible:text-accent-foreground ' +
    'data-[state=selected]:bg-accent data-[state=selected]:text-accent-foreground ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      inset: {
        none: '',
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
    defaultVariants: { inset: 'md', ruled: false, radius: 'none' },
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
>(function Row({ className, inset, ruled, radius, selected, asChild = false, type, ...props }, ref) {
  const Comp = asChild ? SlotPrimitive.Slot : 'button';
  return (
    <Comp
      ref={ref}
      data-slot="row"
      // A row that is a link stays a link: `asChild` hands the paint to an <a>
      // and takes nothing away from it, which is what keeps middle-click and
      // "open in a new tab" working on a list of places to go.
      {...(asChild ? {} : { type: type ?? 'button' })}
      className={cn(rowVariants({ inset, ruled, radius }), className)}
      {...(selected && { 'data-state': 'selected' })}
      {...props}
    />
  );
});
Row.displayName = 'Row';

export { Row, rowVariants };
