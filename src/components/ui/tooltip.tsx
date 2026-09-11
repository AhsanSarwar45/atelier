"use client"

import * as React from "react"

import { Slot } from "@radix-ui/react-slot"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

/**
 * The app's one hover label.
 *
 * There were three of these — the browser's own `title`, Radix mounted by hand
 * at a call site, and a panel the status donut positioned itself — so the same
 * gesture answered in three looks, at three speeds, and a change to any of it
 * had no one place to be made (bw-6wq6.1). This is that place: everything that
 * says something on hover says it through `Tooltip`.
 *
 * Every screen passes through here, so the rules live here rather than at each
 * call site: the delay, the dark overlay face, and the wrapper a disabled
 * control needs before it can be hovered at all.
 */

/** Whether an app-level provider is already above us. */
const Mounted = React.createContext(false);

const DELAY = 250;

/**
 * Mounted once, at the root of the app. Radix uses it to let a second label
 * open at once when the reader is already reading a first — moving along a
 * toolbar should not re-serve the delay on every button.
 */
export function TooltipProvider({
  children,
  delayDuration = DELAY,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <Mounted.Provider value={true}>
      <TooltipPrimitive.Provider delayDuration={delayDuration} {...props}>
        {children}
      </TooltipPrimitive.Provider>
    </Mounted.Provider>
  );
}

export type TooltipProps = {
  /**
   * What the label says. Rich content is allowed — a list of blockers, a
   * breakdown of counts — because the alternative is a second mechanism for
   * the cases a string cannot carry, which is what this component replaced.
   *
   * Nothing to say means no tooltip at all: the child is returned untouched,
   * so a caller may pass a value that is only sometimes there.
   */
  label?: React.ReactNode;
  children: React.ReactElement;
  side?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['side'];
  align?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>['align'];
  /** On the label, never on the trigger. */
  className?: string;
  /**
   * On the wrapper a disabled trigger gets, for the cases where the control
   * fills its row: the wrapper is shrink-to-fit, so a `w-full` child inside a
   * block would otherwise collapse to its own width.
   */
  wrapperClassName?: string;
  delayDuration?: number;
};

/**
 * A label is often asked for on a control that is already the child of
 * something else that wants to be that control — a menu's trigger, a dialog's.
 * Those parents hand their child props and a ref through `asChild`, so this
 * component has to be see-through: whatever it is given it passes on to the
 * control below it, rather than swallowing it and leaving a menu that cannot
 * find the button it opens from (bw-6wq6.2).
 */
export const Tooltip = React.forwardRef<HTMLElement, TooltipProps>(function Tooltip(
  { label, children, side = 'top', align = 'center', className, wrapperClassName, delayDuration, ...rest },
  ref,
) {
  const mounted = React.useContext(Mounted);
  const [open, setOpen] = React.useState(false);
  const dismissed = React.useRef(false);
  const passed = rest as React.ComponentPropsWithoutRef<typeof Slot>;
  if (label === undefined || label === null || label === '') {
    return <Slot ref={ref} {...passed}>{children}</Slot>;
  }

  // A disabled control takes no pointer events, so it is never hovered and can
  // never be the thing the reader is pointing at. Hovering it is exactly when
  // the label matters most — why the button is grey — so the wrapper is what
  // carries the label, and it takes focus so a keyboard reaches the same
  // sentence (bw-uyk2.1).
  const props = children.props as { disabled?: boolean };
  const inner = props?.disabled ? (
    <span
      tabIndex={0}
      className={cn(
        'inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        wrapperClassName,
      )}
    >
      {children}
    </span>
  ) : (
    children
  );

  const tooltip = (
    <TooltipPrimitive.Root delayDuration={delayDuration} open={open} onOpenChange={(next) => setOpen(next && !dismissed.current)}>
      <TooltipPrimitive.Trigger asChild>
        <Slot
          ref={ref}
          {...passed}
          onPointerDownCapture={() => { dismissed.current = true; setOpen(false); }}
          onPointerLeave={() => { dismissed.current = false; setOpen(false); }}
        >{inner}</Slot>
      </TooltipPrimitive.Trigger>
      <TooltipContent side={side} align={align} className={className}>
        {label}
      </TooltipContent>
    </TooltipPrimitive.Root>
  );

  // A screen under test, or a panel drawn before the root has mounted, still
  // gets its labels: Radix refuses a tooltip with no provider above it, so one
  // is supplied here when there is none.
  return mounted ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
});

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  // Drawn on the document, not beside the button it belongs to. A label
  // rendered in place is inside whatever the button is inside, so every pane
  // that scrolls or clips its contents — a bar, a toolbar, the chat list —
  // cut the label in half, and one opened inside the chat list was a white
  // sliver against the edge of the screen (bw-81wt.31). Every other floating
  // thing in this app already goes out to the document this way; this was the
  // one that did not.
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        // Line breaks in a label are kept, because the browser's own label
        // kept them and several of the app's longest labels are written as two
        // or three lines rather than one long one (bw-6wq6.2).
        //
        // The face of every other floating thing in the app: the overlay
        // surface, the app's own border, its primary text. Which is dark with
        // near-white writing in this skin, and follows the skin where a reader
        // has chosen a light one — a tooltip that named its own colours was
        // white-on-dark in a dark app, the one panel that did not belong to it
        // (bw-6wq6.1).
        "z-50 max-w-xs overflow-hidden whitespace-pre-line rounded-md border border-border/60 bg-surface-overlay px-3 py-1.5 text-xs text-t-primary shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName
