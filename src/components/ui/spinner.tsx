import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The turning ring that says "still working". About forty screens drew their
 * own `Loader2 animate-spin`, each picking a size by hand; the sizes here are
 * the ones `Button` gives an icon at the same size, so a spinner standing in
 * for a button's icon is exactly as big as the icon it replaces.
 *
 * `inherit` draws no size at all, for a spinner inside something that already
 * sizes its icons — which is how `<Button loading>` uses it.
 */
const spinnerVariants = cva("animate-spin shrink-0", {
  variants: {
    size: {
      inherit: "",
      "2xs": "size-3",
      xs: "size-3.5",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-4",
    },
  },
  defaultVariants: {
    size: "md",
  },
})

type SpinnerProps = Omit<React.ComponentProps<typeof Loader2>, "size"> &
  VariantProps<typeof spinnerVariants> & {
    /**
     * Said out loud when given. Without one the spinner is decoration, hidden
     * from a screen reader, because whatever it sits in already says what is
     * happening — a button reading "Saving…", say.
     */
    label?: string
  }

const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size, label, ...props }, ref) => (
    <Loader2
      ref={ref}
      data-slot="spinner"
      className={cn(spinnerVariants({ size }), className)}
      {...(label
        ? { role: "status", "aria-label": label }
        : { "aria-hidden": true })}
      {...props}
    />
  )
)
Spinner.displayName = "Spinner"

export { Spinner, spinnerVariants }
