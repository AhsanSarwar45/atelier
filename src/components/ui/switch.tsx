"use client"

import * as React from "react"

import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * The application's on/off switch, for a setting that takes effect the moment
 * it is flipped. The shared library drew one by hand inside a `Button` given
 * `role="switch"`; this is the same track and thumb on the primitive, so the
 * keyboard, `aria-checked` and the form value come with it.
 *
 * Like `Checkbox`, the painted track keeps its size on every screen and a
 * thumb's forty-four pixels come from the invisible pseudo-element instead
 * (bw-e3dw.6), which is why the coarse-pointer floor is turned off here.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer relative inline-flex h-5 w-9 !min-h-0 !min-w-0 shrink-0 cursor-pointer items-center rounded-full px-0.5 transition-colors outline-none before:absolute before:-inset-x-1 before:-inset-y-3 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-t-muted/40",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
