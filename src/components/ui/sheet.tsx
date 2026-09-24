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
 * close it, a press on its own trigger (or on anything that names it in
 * `aria-controls`) is left to that control, and focus moves into it when it
 * opens and back when it shuts. The dimming behind it is the sheet's own,
 * since a non-modal dialog draws none.
 *
 * Two things the rails need that a popup does not:
 *
 * - `forceMount` keeps it drawn while shut, so what is in it — a folder tree
 *   opened three levels deep, a half-written commit message — is still there
 *   the next time it opens, and it and its dimming can fade rather than snap.
 *   Shut, it is `inert`: nothing in it can be reached.
 * - `docked` on the root makes it a plain column of the row, on a screen wide
 *   enough to have one: no dimming, no dismissing, no focus moved, nothing
 *   announced as a dialog — the caller's own classes place it.
 *
 * It is drawn by this file rather than by Radix's dialog content because a
 * Radix layer that stays mounted while shut still answers every Escape on the
 * page and takes focus the moment it mounts.
 */
const SheetContainedContext = React.createContext<{
  contained: boolean
  docked: boolean
  open: boolean
  close: () => void
  id: string
}>({ contained: false, docked: false, open: false, close: () => {}, id: "" })

type SheetProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Root> & {
  contained?: boolean
  /** A contained sheet that is, for now, a column of the row: see above. */
  docked?: boolean
}

function Sheet({
  contained = false,
  docked = false,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  modal,
  ...props
}: SheetProps) {
  const [openState, setOpenState] = React.useState(defaultOpen)
  const open = openProp ?? openState
  const id = React.useId()
  const change = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange]
  )
  const held = React.useMemo(
    () => ({ contained, docked: contained && docked, open, close: () => change(false), id }),
    [contained, docked, open, change, id]
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

const SheetTrigger = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>
>((props, ref) => {
  const { contained, id } = React.useContext(SheetContainedContext)
  return (
    <SheetPrimitive.Trigger
      ref={ref}
      {...(contained ? { "data-sheet-trigger": id } : {})}
      {...props}
    />
  )
})
SheetTrigger.displayName = SheetPrimitive.Trigger.displayName

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

/** Where each side's sheet sits and how big it is, without how it moves. */
const SHEET_SIDE = {
  top: "inset-x-0 top-0 border-b",
  bottom: "inset-x-0 bottom-0 border-t",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
} as const

const SHEET_BOX = "fixed z-50 gap-4 bg-background p-6 shadow-lg"

const sheetVariants = cva(
  `${SHEET_BOX} transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out`,
  {
    variants: {
      side: {
        top: `${SHEET_SIDE.top} data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top`,
        bottom: `${SHEET_SIDE.bottom} data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom`,
        left: `${SHEET_SIDE.left} data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left`,
        right: `${SHEET_SIDE.right} data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right`,
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
   * Anything else the dimming behind a contained sheet carries — a test id, in
   * practice, since it is a thing a reader presses.
   */
  overlayProps?: Record<`data-${string}`, string | number | boolean | undefined>
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

const SheetCross = () => (
  <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
    <X className="h-4 w-4" />
    <span className="sr-only">Close</span>
  </SheetPrimitive.Close>
)

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, overlayClassName, overlayProps, hideClose, ...props }, ref) => {
  const { contained } = React.useContext(SheetContainedContext)
  if (contained) {
    return (
      <ContainedSheetContent
        ref={ref}
        side={side}
        className={className}
        overlayClassName={overlayClassName}
        overlayProps={overlayProps}
        hideClose={hideClose}
        {...props}
      >
        {children}
      </ContainedSheetContent>
    )
  }
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {!hideClose && <SheetCross />}
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
})
SheetContent.displayName = SheetPrimitive.Content.displayName

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The newest value, for a listener that is added once and reads it later. */
function useLatest<T>(value: T) {
  const held = React.useRef(value)
  React.useEffect(() => {
    held.current = value
  })
  return held
}

type OutsideEvent = CustomEvent<{ originalEvent: PointerEvent }>

const ContainedSheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  (
    {
      side = "right",
      className,
      children,
      overlayClassName,
      overlayProps,
      hideClose,
      forceMount,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      // Taken off so they do not land on the element; a contained sheet does
      // not close when focus merely wanders off it.
      onFocusOutside: _onFocusOutside,
      onOpenAutoFocus,
      onCloseAutoFocus,
      onPointerDownCapture,
      id: idProp,
      ...props
    },
    ref
  ) => {
    const { open, docked, close, id: rootId } = React.useContext(SheetContainedContext)
    const node = React.useRef<HTMLDivElement | null>(null)
    const pressedInside = React.useRef(false)
    const id = idProp ?? `${rootId}-sheet`
    const up = open && !docked
    const heard = useLatest({
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      onOpenAutoFocus,
      onCloseAutoFocus,
      close,
    })

    // Escape and a press outside, and only while it is up. Escape is heard on
    // its way back up the page, so a menu or a window opened from inside it
    // that already answered the key (and said so) is not shut along with it.
    React.useEffect(() => {
      if (!up) return
      const keyed = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        heard.current.onEscapeKeyDown?.(event)
        if (event.defaultPrevented) return
        event.preventDefault()
        heard.current.close()
      }
      const pressed = (event: PointerEvent) => {
        // A press inside it in React's tree — a menu it opened, portalled to
        // the body — is inside it, wherever the page drew that menu.
        if (pressedInside.current) {
          pressedInside.current = false
          return
        }
        const target = event.target
        if (!(target instanceof Element) || node.current?.contains(target)) return
        if (target.closest(`[data-sheet-trigger="${rootId}"]`)) return
        if (target.closest(`[aria-controls~="${CSS.escape(id)}"]`)) return
        const outside: OutsideEvent = new CustomEvent("sheet.pointerDownOutside", {
          cancelable: true,
          detail: { originalEvent: event },
        })
        target.dispatchEvent(outside)
        heard.current.onPointerDownOutside?.(outside)
        heard.current.onInteractOutside?.(outside)
        if (!outside.defaultPrevented) heard.current.close()
      }
      document.addEventListener("keydown", keyed)
      document.addEventListener("pointerdown", pressed)
      return () => {
        document.removeEventListener("keydown", keyed)
        document.removeEventListener("pointerdown", pressed)
      }
    }, [up, heard, rootId, id])

    // Focus in on the way up, and back where it was on the way down — unless
    // the reader has already put it somewhere else.
    React.useEffect(() => {
      if (!up) return
      const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const opening = new Event("sheet.openAutoFocus", { cancelable: true })
      heard.current.onOpenAutoFocus?.(opening)
      const box = node.current
      if (!opening.defaultPrevented && box && !box.contains(document.activeElement)) {
        const first = box.querySelector<HTMLElement>(FOCUSABLE)
        ;(first ?? box).focus({ preventScroll: true })
      }
      return () => {
        const closing = new Event("sheet.closeAutoFocus", { cancelable: true })
        heard.current.onCloseAutoFocus?.(closing)
        if (closing.defaultPrevented) return
        const now = document.activeElement
        const lost = !now || now === document.body || Boolean(box?.contains(now))
        if (lost && before?.isConnected) before.focus({ preventScroll: true })
      }
    }, [up, heard])

    // Shut and still drawn: out of reach of the keyboard and of a screen
    // reader, not only out of sight. Set on the element, because this React
    // does not know the attribute.
    const shutAway = !open && !docked
    React.useEffect(() => {
      node.current?.toggleAttribute("inert", shutAway)
    }, [shutAway])

    const setRef = React.useCallback(
      (element: HTMLDivElement | null) => {
        node.current = element
        if (typeof ref === "function") ref(element)
        else if (ref) ref.current = element
      },
      [ref]
    )

    if (!open && !forceMount) return null
    const state = open ? "open" : "closed"
    return (
      <>
        {!docked && (
          <div
            aria-hidden="true"
            data-slot="sheet-overlay"
            data-state={state}
            {...overlayProps}
            className={cn(
              "absolute inset-0 z-40 bg-black/80 transition-opacity duration-200 ease-out motion-reduce:transition-none",
              open ? "opacity-100" : "pointer-events-none opacity-0",
              overlayClassName
            )}
            onClick={close}
          />
        )}
        <div
          ref={setRef}
          id={id}
          role={docked ? undefined : "dialog"}
          aria-labelledby={docked || props["aria-label"] ? undefined : `${rootId}-title`}
          tabIndex={docked ? undefined : -1}
          data-state={state}
          className={cn(
            // Kept drawn, it is a panel its caller paints and moves; the
            // library gives it only its edge, its fill and its stacking.
            !docked && (forceMount ? cn("z-50 bg-background", SHEET_SIDE[side ?? "right"]) : sheetVariants({ side })),
            !docked && "absolute outline-none",
            className
          )}
          onPointerDownCapture={(event) => {
            pressedInside.current = true
            onPointerDownCapture?.(event)
          }}
          {...props}
        >
          {!hideClose && !docked && <SheetCross />}
          {children}
        </div>
      </>
    )
  }
)
ContainedSheetContent.displayName = "ContainedSheetContent"

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
>(({ className, ...props }, ref) => {
  const { contained, id } = React.useContext(SheetContainedContext)
  return (
    <SheetPrimitive.Title
      ref={ref}
      // A contained sheet is drawn here rather than by Radix, so it names its
      // own title for the window it heads.
      {...(contained ? { id: `${id}-title` } : {})}
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  )
})
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
