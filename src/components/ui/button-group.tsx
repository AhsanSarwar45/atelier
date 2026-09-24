import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Buttons joined into one control — a split button's action and its menu of
 * options, a choice beside the star that makes it the default. The chat list
 * and the chat tab each built this with `rounded-r-none` on one half and
 * `rounded-l-none` on the other and a seam of their own choosing.
 *
 * The corners are squared where two buttons meet, on the buttons themselves or
 * on the first `Button` inside a wrapper such as a tooltip's. `seam` says how
 * the join is drawn: `line` is a faint rule, for filled buttons, whose own
 * edges would otherwise run together; `overlap` pulls each outlined button one
 * pixel over the last, so two borders make one line rather than two.
 */
const buttonGroupVariants = cva(
  "flex min-w-0 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none [&>*:not(:first-child)_[data-slot=button]]:rounded-l-none [&>*:not(:last-child)_[data-slot=button]]:rounded-r-none",
  {
    variants: {
      seam: {
        line: "[&>*:not(:first-child)]:border-l [&>*:not(:first-child)]:border-primary-foreground/20",
        overlap: "[&>*:not(:first-child)]:-ml-px",
      },
    },
    defaultVariants: {
      seam: "line",
    },
  }
)

const ButtonGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>
>(({ className, seam, ...props }, ref) => (
  <div
    ref={ref}
    role="group"
    data-slot="button-group"
    className={cn(buttonGroupVariants({ seam }), className)}
    {...props}
  />
))
ButtonGroup.displayName = "ButtonGroup"

export { ButtonGroup, buttonGroupVariants }
