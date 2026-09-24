"use client"

import * as React from "react"

import * as TabsPrimitive from "@radix-ui/react-tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/*
 * Two looks for a row of tabs. `default` is the pill of choices on a settings
 * page. `strip` is an editor's row of open things — files, shells — flush
 * under a pane's bar, one tab against the next, the current one lifted to the
 * page's own colour. The open-files strip and the terminal's tab strip each
 * drew that by hand; the list says which look it is and every trigger in it
 * takes the same one.
 */
const tabsListVariants = cva("", {
  variants: {
    variant: {
      default:
        "inline-flex h-12 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground sm:h-9",
      strip:
        "flex shrink-0 items-stretch overflow-x-auto border-b border-b-default bg-surface-inset/40",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

const tabsTriggerVariants = cva(
  "inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "h-10 justify-center rounded-md px-3 py-1 text-sm font-medium focus-visible:ring-offset-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow sm:h-7",
        strip:
          "min-w-0 gap-1.5 px-2.5 py-1.5 text-xs focus-visible:ring-inset data-[state=active]:bg-surface-base data-[state=active]:text-t-primary data-[state=inactive]:text-t-muted data-[state=inactive]:hover:bg-surface-raised/60 data-[state=inactive]:hover:text-t-secondary [&_svg]:size-3.5 [&_svg]:shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type TabsVariant = VariantProps<typeof tabsListVariants>["variant"]

const TabsVariantContext = React.createContext<TabsVariant>("default")

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> &
    VariantProps<typeof tabsListVariants>
>(({ className, variant = "default", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  </TabsVariantContext.Provider>
))
TabsList.displayName = TabsPrimitive.List.displayName

type TabsTriggerProps = React.ComponentPropsWithoutRef<
  typeof TabsPrimitive.Trigger
> & {
  /**
   * Draws a cross beside the tab that closes it, and closes it on a middle
   * click too. The cross is a button of its own BESIDE the tab rather than
   * inside it — a button inside a button is neither valid nor operable, and
   * closing a tab is not a way of choosing it — so pressing it never makes its
   * tab the current one, and Tab reaches it from the keyboard.
   */
  onClose?: () => void
  /** What the cross is called out loud: "Close index.ts". */
  closeLabel?: string
  /** On the box that holds the tab and its cross, when it has one. */
  containerClassName?: string
}

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, onClose, closeLabel, containerClassName, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext)
  const trigger = (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        tabsTriggerVariants({ variant }),
        onClose ? "pr-1" : variant === "strip" && "border-r border-r-default",
        className
      )}
      {...props}
    />
  )
  if (!onClose) return trigger
  return (
    <div
      data-slot="tab"
      className={cn(
        "group/tab flex shrink-0 items-center",
        variant === "strip" &&
          "max-w-[16rem] border-r border-r-default has-[[data-state=active]]:bg-surface-base",
        containerClassName
      )}
      // A middle click on a scrollable strip otherwise starts the browser's
      // own auto-scroll and leaves the tab open underneath it.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onClose()
      }}
    >
      {trigger}
      <Button
        type="button"
        size="2xs"
        mode="icon"
        variant="ghost"
        data-slot="tab-close"
        aria-label={closeLabel ?? "Close"}
        className={cn(
          "mr-1 size-4 text-t-faint hover:text-t-primary [&_svg]:size-3",
          // Out of the way until the tab is being used, so a strip at rest
          // reads as names rather than as a row of crosses.
          "opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 group-has-[[data-state=active]]/tab:opacity-100"
        )}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants, tabsTriggerVariants }
