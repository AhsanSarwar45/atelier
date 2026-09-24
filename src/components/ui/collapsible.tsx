"use client"

import * as React from "react"

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { cva, type VariantProps } from "class-variance-authority"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A section that folds away: a card's Design and Notes, a library item's
 * "Why?", a chat's todo panel. Eight screens each wrote their own `<details>`
 * for it, with their own marker and their own idea of how the marker turns.
 *
 * `CollapsibleTrigger` is the bare primitive, for a header that draws itself
 * (`asChild` onto a `Panel`'s heading, say). `CollapsibleTriggerRow` is the
 * common case already drawn: a line of words led by a chevron that turns to
 * point down when the section is open — the look the card's `<details>` had.
 */
const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.Trigger

const collapsibleTriggerRowVariants = cva(
  "group/collapsible flex cursor-pointer items-center gap-1.5 text-left text-t-secondary transition-colors hover:text-t-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0",
  {
    variants: {
      size: {
        // A section heading, as on a card's Design and Notes.
        md: "text-sm font-semibold [&>svg]:size-3.5",
        // A small aside under something else, as on "Why? · Inspect content".
        sm: "text-xs [&>svg]:size-3",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
)

const CollapsibleTriggerRow = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger> &
    VariantProps<typeof collapsibleTriggerRowVariants>
>(({ className, size, children, ...props }, ref) => (
  <CollapsiblePrimitive.Trigger
    ref={ref}
    className={cn(collapsibleTriggerRowVariants({ size }), className)}
    {...props}
  >
    <ChevronRight
      aria-hidden="true"
      className="transition-transform group-data-[state=open]/collapsible:rotate-90"
    />
    {children}
  </CollapsiblePrimitive.Trigger>
))
CollapsibleTriggerRow.displayName = "CollapsibleTriggerRow"

const CollapsibleContent = CollapsiblePrimitive.Content

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleTriggerRow,
  CollapsibleContent,
  collapsibleTriggerRowVariants,
}
