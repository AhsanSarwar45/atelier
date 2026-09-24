"use client"

import * as React from "react"

import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/*
 * A sheet held inside a box rather than over the window. The chat's two rails
 * and the Files tab's drawer slide over the work area on a phone and stop at
 * its edges, so the bar they were opened from stays uncovered and its toggle
 * can still be pressed (bw-e3dw.9). A window-wide modal cannot do that: it
 * covers the bar and turns every press outside itself off.
 *
 * So a `contained` sheet is not portalled — it is drawn where it is written,
 * `absolute` against the nearest positioned box — and it is not modal, so the
 * rest of the screen still takes presses. Escape and a press outside still
 * close it, a press on its own trigger is left to the trigger, and focus moves
 * into it when it opens and back when it shuts. The dimming behind it is the
 * sheet's own, since a non-modal dialog draws none.
 */
const SheetContainedContext = React.createContext<{
  contained: boolean
  open: boolean
  close: () => void
}>({ contained: false, open: false, close: () => {} })

type SheetProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Root> & {
  contained?: boolean
}

function Sheet({
  contained = false,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  modal,
  ...props
}: SheetProps) {
  const [openState, setOpenState] = React.useState(defaultOpen)
  const open = openProp ?? openState
  const change = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )
  const held = React.useMemo(
    () => ({ contained, open, close: () => change(false) }),
    [contained, open, change]
  )
  return (
    <SheetContainedContext.Provider value={held}>
      <SheetPrimitive.Root
        open={open}
        onOpenChange={change}
        modal={contained ? false : modal}
        {...props}
      />
    </SheetContainedContext.Provider>
  )
}

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  overlayClassName?: string
  /**
   * Draw no cross in the corner.
   *
   * A panel that already carries a Back control does not want a second way out
   * at the opposite end of a screen held in one hand (bw-81wt.6). Without this
   * the only way to leave the cross out was to stop using the sheet, which is
   * how a panel ends up hand-painted.
   */
  hideClose?: boolean
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, overlayClassName, hideClose, ...props }, ref) => {
  const { contained, open, close } = React.useContext(SheetContainedContext)
  const content = (
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side }), contained && "absolute", className)}
      {...props}
    >
      {!hideClose && (
        <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      )}
      {children}
    </SheetPrimitive.Content>
  )
  if (!contained) {
    return (
      <SheetPortal>
        <SheetOverlay className={overlayClassName} />
        {content}
      </SheetPortal>
    )
  }
  return (
    <>
      {open && (
        <div
          aria-hidden="true"
          data-slot="sheet-overlay"
          data-state="open"
          className={cn(
            "absolute inset-0 z-40 bg-black/80 animate-in fade-in-0",
            overlayClassName
          )}
          onClick={close}
        />
      )}
      {content}
    </>
  )
})
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
