"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The application's checkbox.
 *
 * Its painted box stays sixteen pixels on every screen. The coarse-pointer
 * target is supplied by the invisible pseudo-element instead of enlarging the
 * box itself, so a thumb gets forty pixels without changing the layout.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "relative inline-flex size-4 !min-h-0 !min-w-0 shrink-0 items-center justify-center rounded-[4px] border border-b-strong bg-background text-primary-foreground outline-none before:absolute before:-inset-3 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      {props.checked === "indeterminate"
        ? <Minus className="size-3" aria-hidden="true" />
        : <Check className="size-3" aria-hidden="true" />}
    </CheckboxPrimitive.Indicator>
    {children}
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
