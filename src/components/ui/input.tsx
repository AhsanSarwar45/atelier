import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "flex w-full rounded-md border border-input bg-transparent shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        md: "h-9 px-3 py-1 text-base md:text-sm",
        // The field in a pane's own toolbar, beside `xs` buttons: a commit
        // search, a catalogue's filter.
        sm: "h-7 px-3 py-1 text-xs",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
)

/*
 * Room left inside the field for what sits at either end, and where that thing
 * sits. The field's own words start after it rather than under it. `md` is the
 * search box's (a sixteen-pixel icon ten pixels in); `sm` is the commit
 * search's (fourteen pixels, eight in, and an `xs` clear button at the end).
 */
const inputSlotVariants = cva(
  "absolute top-1/2 flex -translate-y-1/2 items-center text-muted-foreground",
  {
    variants: {
      size: {
        md: "[&>svg]:size-4",
        sm: "[&>svg]:size-3.5",
      },
      side: {
        start: "pointer-events-none [&>:not(svg)]:pointer-events-auto",
        end: "",
      },
    },
    compoundVariants: [
      { size: "md", side: "start", className: "left-2.5" },
      { size: "md", side: "end", className: "right-1" },
      { size: "sm", side: "start", className: "left-2" },
      { size: "sm", side: "end", className: "right-0.5" },
    ],
  }
)

const ROOM = {
  md: { start: "pl-8", end: "pr-9" },
  sm: { start: "pl-7", end: "pr-7" },
} as const

type InputProps = Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants> & {
    /** An icon (or a small button) drawn inside the field, before the words. */
    start?: React.ReactNode
    /** The same after the words, which is where a "clear" button goes. */
    end?: React.ReactNode
    /** On the box that holds the field and its slots, when there are slots. */
    containerClassName?: string
  }

/**
 * The application's text field. Without `start` or `end` it is the bare
 * `<input>` it always was; with either, it is wrapped in a box the slots are
 * placed against, and `className` still lands on the `<input>` itself.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, start, end, containerClassName, ...props }, ref) => {
    const room = ROOM[size ?? "md"]
    const field = (
      <input
        type={type}
        className={cn(
          inputVariants({ size }),
          start != null && room.start,
          end != null && room.end,
          className
        )}
        ref={ref}
        {...props}
      />
    )
    if (start == null && end == null) return field
    return (
      <div className={cn("relative w-full min-w-0", containerClassName)}>
        {start != null && (
          <span data-slot="input-start" className={inputSlotVariants({ size, side: "start" })}>
            {start}
          </span>
        )}
        {field}
        {end != null && (
          <span data-slot="input-end" className={inputSlotVariants({ size, side: "end" })}>
            {end}
          </span>
        )}
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input, inputVariants }
