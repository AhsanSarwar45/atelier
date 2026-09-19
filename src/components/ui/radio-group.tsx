'use client';

/**
 * The application's radio group: one answer out of a few, all of them visible.
 *
 * `Select` is the library's answer when the choices are interchangeable names —
 * a branch, a provider tab — and the reader already knows which one they want.
 * This is the answer when the choices are consequences and the reader is
 * deciding between them, because a menu that has to be opened shows one at a
 * time and hides what picking the other would cost.
 *
 * `RadioGroupOption` is the shape that use has: a bordered row carrying the
 * dot, what the choice is called, and a line saying what it means. Settings
 * kept needing it, and a screen spelling out its own row is how the app grows
 * two of them that disagree (bw-t2m2.3).
 *
 * The dot is the same sixteen painted pixels as `Checkbox`, for the same
 * reason — the row it sits in is the target a thumb lands on.
 */

import * as React from 'react';

import { Circle } from 'lucide-react';
import { Label as LabelPrimitive, RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2', className)} {...props} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'size-4 !min-h-0 !min-w-0 shrink-0 rounded-full border border-b-strong bg-background text-primary outline-none',
      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-primary',
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <Circle className="size-2 fill-primary text-primary" aria-hidden="true" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

/**
 * One choice, drawn as a row the whole of which is clickable.
 *
 * `means` is what taking this one does, in the reader's terms. It is not
 * decoration: a choice worth drawing this way is one whose consequence is the
 * thing being chosen between.
 */
const RadioGroupOption = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> & {
    /** What the choice is called. */
    children: React.ReactNode;
    /** What taking it means, in a line. */
    means?: React.ReactNode;
  }
>(({ children, means, className, id, ...props }, ref) => {
  const generated = React.useId();
  const own = id ?? generated;
  return (
    <Panel inset="sm" className={cn('has-data-[state=checked]:border-primary/50', className)}>
      <div className="flex items-start gap-3">
        <RadioGroupItem ref={ref} id={own} className="mt-0.5" {...props} />
        <LabelPrimitive.Root htmlFor={own} className="block cursor-pointer">
          <span className="block text-sm text-t-primary">{children}</span>
          {means && <span className="mt-0.5 block text-xs text-t-muted">{means}</span>}
        </LabelPrimitive.Root>
      </div>
    </Panel>
  );
});
RadioGroupOption.displayName = 'RadioGroupOption';

export { RadioGroup, RadioGroupItem, RadioGroupOption };
