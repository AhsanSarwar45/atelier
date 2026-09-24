"use client"

import * as React from "react"

import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * A row of choices of which one is taken: Source / Preview over a file, the
 * scope of a search, a catalogue's categories. Nine screens drew this as a
 * line of `Button`s switching between `secondary` and `ghost` with
 * `aria-pressed` set by hand; the items here are those same buttons, so a
 * screen moved onto it looks as it did, and the group brings the arrow keys
 * and says which choice is taken the way a screen reader expects.
 *
 * `size` is set once on the group and every item takes it. `2xs` is the
 * twenty-pixel switch that sits in a pane's toolbar.
 *
 * `variant` is how the row is painted, also set once:
 * - `default`: quiet choices, the taken one on the secondary fill — a pane's
 *   toolbar.
 * - `outline`: each choice a bordered button, the taken one filled with the
 *   accent — a dialog's choice of agent or worktree, a filter's time window.
 * - `media`: white on the dark bar laid over a picture.
 */
type ToggleGroupSize = VariantProps<typeof buttonVariants>["size"]

const toggleGroupItemVariants = cva("", {
  variants: {
    variant: {
      default:
        "data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground data-[state=on]:shadow-xs data-[state=on]:shadow-black/5 data-[state=on]:hover:bg-secondary/90 data-[state=on]:hover:text-secondary-foreground",
      outline:
        "data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground",
      media:
        "text-white hover:bg-white/10 hover:text-white data-[state=on]:bg-white/20",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

type ToggleGroupVariant = VariantProps<typeof toggleGroupItemVariants>["variant"]

const ToggleGroupContext = React.createContext<{
  size: ToggleGroupSize
  variant: ToggleGroupVariant
}>({
  size: "xs",
  variant: "default",
})

type ToggleGroupProps = React.ComponentPropsWithoutRef<
  typeof ToggleGroupPrimitive.Root
> & {
  size?: ToggleGroupSize
  variant?: ToggleGroupVariant
  /**
   * A single group whose choice can be taken back: pressing the taken one
   * leaves none taken and says so with `""`. A filter's "Since" is like this —
   * no window at all is an answer — where a Source / Preview switch is not.
   */
  optional?: boolean
}

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  ToggleGroupProps
>(({ className, size = "xs", variant = "default", optional = false, children, ...props }, ref) => {
  // Pressing the choice already taken would otherwise leave none taken, which
  // a segmented switch never means. A single group only ever hears about a
  // real choice, unless it says none is one.
  const guarded =
    props.type === "single" && props.onValueChange && !optional
      ? {
          ...props,
          onValueChange: (value: string) => {
            if (value) (props.onValueChange as (value: string) => void)(value)
          },
        }
      : props
  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      className={cn("flex items-center gap-0.5", className)}
      {...(guarded as React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>)}
    >
      <ToggleGroupContext.Provider value={{ size, variant }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
})
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...given }, ref) => {
  const { size, variant } = React.useContext(ToggleGroupContext)
  // An item wrapped in a `Tooltip` is handed the tooltip's own `data-state`,
  // which would otherwise land after the item's "on" and unpaint the choice.
  const { "data-state": _tooltipState, ...props } = given as typeof given & {
    "data-state"?: string
  }
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-slot="toggle-group-item"
      className={cn(
        buttonVariants({ variant: variant === "outline" ? "outline" : "ghost", size }),
        toggleGroupItemVariants({ variant }),
        className
      )}
      {...props}
    />
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants }
