/**
 * The chip: every pill of text in the app, whatever it names.
 *
 * Its colours are the `--color-*` names spelled once in `src/app/globals.css`
 * against whichever theme is live; a hue the data carries comes in as `hue`
 * (docs/designs/app-shell.md §1.5). Nothing here writes a finished colour.
 */
import * as React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot as SlotPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  dotClassName?: string;
  disabled?: boolean;
}

export interface BadgeButtonProps
  extends React.ButtonHTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeButtonVariants> {
  asChild?: boolean;
}

export type BadgeDotProps = React.HTMLAttributes<HTMLSpanElement>;

const badgeVariants = cva(
    // Clicked, a chip brightens its OWN border and nothing else. It used to throw
  // a two-pixel ring an offset away from itself, which on a line of chips drew a
  // halo over the chips either side of it and read as an error box — the manager
  // saw one and asked for the outline gone (bw-4wcd.6). The border is already
  // there and already transparent, so lighting it moves nothing.
  'inline-flex items-center whitespace-nowrap justify-center border border-transparent font-medium focus:outline-hidden focus-visible:outline-hidden focus-visible:border-current [&_svg]:-ms-px [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        success:
          'bg-[var(--color-success-accent)] text-[var(--color-success-foreground,var(--color-white))]',
        warning:
          'bg-[var(--color-warning-accent)] text-[var(--color-warning-foreground,var(--color-white))]',
        info: 'bg-[var(--color-info-accent)] text-[var(--color-info-foreground,var(--color-white))]',
        outline: 'bg-transparent border border-border text-secondary-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
        // A card that holds other cards has its own colour in every theme.
        epic: 'bg-[var(--color-epic-accent)] text-[var(--color-epic-foreground)]',
      },
      appearance: {
        default: '',
        light: '',
        outline: '',
        ghost: 'border-transparent bg-transparent',
      },
      disabled: {
        true: 'opacity-50 pointer-events-none',
      },
      size: {
        lg: 'rounded-md px-[0.5rem] h-7 min-w-7 gap-1.5 text-xs [&_svg]:size-3.5',
        md: 'rounded-md px-[0.45rem] h-6 min-w-6 gap-1.5 text-xs [&_svg]:size-3.5 ',
        sm: 'rounded-sm px-[0.325rem] h-5 min-w-5 gap-1 text-[0.6875rem] leading-[0.75rem] [&_svg]:size-3',
        xs: 'rounded-sm px-[0.25rem] h-4 min-w-4 gap-1 text-[0.625rem] leading-[0.5rem] [&_svg]:size-3',
      },
      shape: {
        default: '',
        circle: 'rounded-full',
      },
    },
    compoundVariants: [
      /* Light */
      {
        variant: 'primary',
        appearance: 'light',
        className:
          'text-[var(--color-primary-accent)] bg-[var(--color-primary-soft)]',
      },
      {
        variant: 'secondary',
        appearance: 'light',
        className: 'bg-secondary text-secondary-foreground',
      },
      {
        variant: 'success',
        appearance: 'light',
        className:
          'text-[var(--color-success-accent)] bg-[var(--color-success-soft)]',
      },
      {
        variant: 'warning',
        appearance: 'light',
        className:
          'text-[var(--color-warning-accent)] bg-[var(--color-warning-soft)]',
      },
      {
        variant: 'info',
        appearance: 'light',
        className:
          'text-[var(--color-info-accent)] bg-[var(--color-info-soft)]',
      },
      {
        variant: 'epic',
        appearance: 'light',
        className: 'text-[var(--color-epic-accent)] bg-[var(--color-epic-soft)]',
      },
      {
        variant: 'epic',
        appearance: 'outline',
        className:
          'text-[var(--color-epic-accent)] border-[var(--color-epic-soft)] bg-[var(--color-epic-soft)]',
      },
      {
        variant: 'epic',
        appearance: 'ghost',
        className: 'text-[var(--color-epic-accent)]',
      },
      {
        variant: 'destructive',
        appearance: 'light',
        className:
          'text-[var(--color-destructive-accent)] bg-[var(--color-destructive-soft)]',
      },
      /* Outline */
      {
        variant: 'primary',
        appearance: 'outline',
        className:
          'text-[var(--color-primary-accent)] border-[var(--color-primary-soft)] bg-[var(--color-primary-soft)]',
      },
      {
        variant: 'success',
        appearance: 'outline',
        className:
          'text-[var(--color-success-accent)] border-[var(--color-success-soft)] bg-[var(--color-success-soft)]',
      },
      {
        variant: 'warning',
        appearance: 'outline',
        className:
          'text-[var(--color-warning-accent)] border-[var(--color-warning-soft)] bg-[var(--color-warning-soft)]',
      },
      {
        variant: 'info',
        appearance: 'outline',
        className:
          'text-[var(--color-info-accent)] border-[var(--color-info-soft)] bg-[var(--color-info-soft)]',
      },
      {
        variant: 'destructive',
        appearance: 'outline',
        className:
          'text-[var(--color-destructive-accent)] border-[var(--color-destructive-soft)] bg-[var(--color-destructive-soft)]',
      },
      /* Ghost */
      {
        variant: 'primary',
        appearance: 'ghost',
        className: 'text-primary',
      },
      {
        variant: 'secondary',
        appearance: 'ghost',
        className: 'text-secondary-foreground',
      },
      {
        variant: 'success',
        appearance: 'ghost',
        className: 'text-[var(--color-success-accent)]',
      },
      {
        variant: 'warning',
        appearance: 'ghost',
        className: 'text-[var(--color-warning-accent)]',
      },
      {
        variant: 'info',
        appearance: 'ghost',
        className: 'text-[var(--color-info-accent)]',
      },
      {
        variant: 'destructive',
        appearance: 'ghost',
        className: 'text-destructive',
      },

      { size: 'lg', appearance: 'ghost', className: 'px-0' },
      { size: 'md', appearance: 'ghost', className: 'px-0' },
      { size: 'sm', appearance: 'ghost', className: 'px-0' },
      { size: 'xs', appearance: 'ghost', className: 'px-0' },
    ],
    defaultVariants: {
      variant: 'primary',
      appearance: 'default',
      size: 'md',
    },
  },
);

const badgeButtonVariants = cva(
  'cursor-pointer transition-all inline-flex items-center justify-center leading-none size-3.5 [&>svg]:opacity-100! [&>svg]:size-3.5! p-0 rounded-md -me-0.5 opacity-60 hover:opacity-100',
  {
    variants: {
      variant: {
        default: '',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type BadgeOwnProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
    /**
     * A hue in degrees the DATA carries — a tag hashed to its own colour. It
     * overrides `variant`, and the rest of the chip is mixed against the live
     * theme in `globals.css` (docs/designs/app-shell.md §1.5).
     */
    hue?: number;
  };

/**
 * Forwards its ref, and that is load-bearing rather than tidy.
 *
 * A chip is what the app hangs its pop-ups on — `<PopoverTrigger asChild><Badge
 * asChild><button>` — and the thing that positions a pop-up learns where to put
 * it by measuring the element the trigger's ref points at. React 18 drops a ref
 * handed to a plain function, so that measurement never happened: the `+N` on a
 * chat's line opened its list of the remaining cards a whole viewport above the
 * screen, at the placeholder spot a popper sits at before it is placed, and the
 * manager clicking it saw nothing happen at all (bw-4wcd.5, measured on the
 * running copy 2026-08-19).
 */
const Badge = React.forwardRef<HTMLSpanElement, BadgeOwnProps>(function Badge(
  { className, variant, size, appearance, shape, asChild = false, disabled, hue, style, ...props },
  ref,
) {
  const Comp = asChild ? SlotPrimitive.Slot : 'span';
  const hued = hue !== undefined;

  return (
    <Comp
      ref={ref}
      data-slot="badge"
      className={cn(
        badgeVariants({ variant: hued ? 'outline' : variant, size, appearance, shape, disabled }),
        hued && (appearance === 'light' ? 'badge-hue' : 'badge-hue badge-hue-strong'),
        className,
      )}
      style={hued ? ({ ...style, '--tag-h': String(hue) } as React.CSSProperties) : style}
      {...props}
    />
  );
});

function BadgeButton({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof badgeButtonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : 'span';
  return (
    <Comp
      data-slot="badge-button"
      className={cn(badgeButtonVariants({ variant, className }))}
      role="button"
      {...props}
    />
  );
}

function BadgeDot({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge-dot"
      className={cn('size-1.5 rounded-full bg-[currentColor] opacity-75', className)}
      {...props}
    />
  );
}

export { Badge, BadgeButton, BadgeDot, badgeVariants };
