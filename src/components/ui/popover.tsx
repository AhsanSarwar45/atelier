"use client"

import * as React from "react"

import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

const TOUCH_SCREEN = "(pointer: coarse)"

function watchTouchScreen(heard: () => void) {
  const watched = window.matchMedia?.(TOUCH_SCREEN)
  watched?.addEventListener("change", heard)
  return () => watched?.removeEventListener("change", heard)
}

/*
 * Modal on a touch screen unless told otherwise. A finger tapping outside an
 * open popover to close it otherwise pressed whatever it landed on as well:
 * on touch the library closes on the tap's click, which the page behind has
 * already heard by then. Modal, the page behind takes no taps while the
 * popover is open, so the tap only closes it. A mouse keeps the page live.
 */
function Popover({ modal, ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const touch = React.useSyncExternalStore(
    watchTouchScreen,
    () => Boolean(window.matchMedia?.(TOUCH_SCREEN).matches),
    () => false,
  )
  return <PopoverPrimitive.Root modal={modal ?? touch} {...props} />
}

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border bg-surface-raised border-b-default p-4 text-t-primary shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
