"use client"

import * as React from "react"

import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * What colour the filled part is. A bar that measures an allowance — a plan's
 * usage windows, a task's tokens — turns as it nears its limit, and those
 * screens each kept their own table of which colour meant which trouble. The
 * colours are the theme's own feedback colours, so they follow the theme.
 */
const progressIndicatorVariants = cva("h-full w-full flex-1 transition-all", {
  variants: {
    tone: {
      default: "bg-primary",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-destructive",
    },
  },
  defaultVariants: {
    tone: "default",
  },
})

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> &
    VariantProps<typeof progressIndicatorVariants>
>(({ className, value, tone, ...props }, ref) => (
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
      data-tone={tone ?? "default"}
      className={progressIndicatorVariants({ tone })}
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress, progressIndicatorVariants }
