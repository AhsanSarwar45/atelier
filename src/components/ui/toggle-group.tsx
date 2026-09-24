"use client"

import * as React from "react"

import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import { type VariantProps } from "class-variance-authority"

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
 */
type ToggleGroupSize = VariantProps<typeof buttonVariants>["size"]

const ToggleGroupContext = React.createContext<{ size: ToggleGroupSize }>({
  size: "xs",
})

type ToggleGroupProps = React.ComponentPropsWithoutRef<
  typeof ToggleGroupPrimitive.Root
> & { size?: ToggleGroupSize }

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  ToggleGroupProps
>(({ className, size = "xs", children, ...props }, ref) => {
  // Pressing the choice already taken would otherwise leave none taken, which
  // a segmented switch never means. A single group only ever hears about a
  // real choice.
  const guarded =
    props.type === "single" && props.onValueChange
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
      {...(guarded as ToggleGroupProps)}
    >
      <ToggleGroupContext.Provider value={{ size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
})
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  const { size } = React.useContext(ToggleGroupContext)
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-slot="toggle-group-item"
      className={cn(
        buttonVariants({ variant: "ghost", size }),
        "data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground data-[state=on]:shadow-xs data-[state=on]:shadow-black/5 data-[state=on]:hover:bg-secondary/90 data-[state=on]:hover:text-secondary-foreground",
        className
      )}
      {...props}
    />
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
