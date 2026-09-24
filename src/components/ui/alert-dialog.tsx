"use client"

import * as React from "react"

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog"

import { buttonVariants } from "@/components/ui/button"
import {
  DialogFooter,
  DialogHeader,
  dialogDescriptionStyles,
  dialogOverlayStyles,
  dialogTitleStyles,
  dialogVariants,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * A window that asks before something cannot be taken back.
 *
 * It wears the plain dialog's dim and box, so a question looks like every
 * other window in the app. The earlier file was copied from a Base UI
 * project and painted colours this app never defines, which left the delete
 * confirmation drawn straight over the editor with no box and no dim
 * (bw-weih.1).
 */
const AlertDialog = AlertDialogPrimitive.Root

const AlertDialogTrigger = AlertDialogPrimitive.Trigger

const AlertDialogPortal = AlertDialogPrimitive.Portal

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn(dialogOverlayStyles, className)}
    {...props}
  />
))
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> & {
    /**
     * `box` floats mid-screen everywhere; `sheet` is the same box on a wide
     * screen and a sheet on the bottom edge of a phone, as the plain dialog's
     * own `sheet` shape is — for a question asked from a screen that is itself
     * held in one hand.
     */
    shape?: "box" | "sheet"
  }
>(({ className, shape = "box", ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitive.Content
      ref={ref}
      className={cn(dialogVariants({ shape }), className)}
      {...props}
    />
  </AlertDialogPortal>
))
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName

const AlertDialogHeader = DialogHeader

const AlertDialogFooter = DialogFooter

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn(dialogTitleStyles, className)} {...props} />
))
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description ref={ref} className={cn(dialogDescriptionStyles, className)} {...props} />
))
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName

/** The button that does the irreversible thing; `destructive` unless told otherwise. */
const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(buttonVariants({ variant: "destructive" }), className)}
    {...props}
  />
))
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: "outline" }), className)}
    {...props}
  />
))
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
}
