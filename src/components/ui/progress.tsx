"use client"

import * as React from "react"

import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    // Handed to the primitive as well as drawn, so the bar says how full it is
    // out loud. Without it every bar in the app reported itself as
    // indeterminate however far along it was, because the value was pulled out
    // of the props here and only ever used for the inline transform below.
    // `null` is how the primitive spells "no idea yet", which is the honest
    // answer for a download whose size nothing declared.
    value={value ?? null}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-primary transition-all"
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
