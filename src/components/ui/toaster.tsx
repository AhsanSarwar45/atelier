"use client"

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useToast } from "@/hooks/use-toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, icon, ...props }) {
        return (
          <Toast key={id} data-testid="toast" {...props}>
            {/* Nudged down by a hair so it sits on the title's own line
                rather than on the box's top edge. */}
            {icon && (
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {icon}
              </span>
            )}
            <div className="grid min-w-0 flex-1 gap-0.5">
              {title && <ToastTitle data-testid="toast-title">{title}</ToastTitle>}
              {description && (
                <ToastDescription data-testid="toast-message">
                  {description}
                </ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
