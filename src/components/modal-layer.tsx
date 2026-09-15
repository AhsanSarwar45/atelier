'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { createPortal } from 'react-dom';

/**
 * A screen laid over the whole app, and the only thing that can be reached
 * while it is open.
 *
 * Project settings used to be a box drawn over the project page inside it: it
 * covered the page to the eye, but Tab walked on into the board behind it and
 * a screen reader read both at once. Drawn here instead, it sits outside the
 * shell, the shell is made inert until it closes, and focus moves in on open
 * and back to where it was on close.
 */
export function ModalLayer({
  label,
  children,
  'data-testid': testId,
}: {
  label: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-testid="shell"]');
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shell?.setAttribute('inert', '');
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      shell?.removeAttribute('inert');
      if (before?.isConnected) before.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      className="fixed inset-0 z-40 outline-none"
    >
      {children}
    </div>,
    document.body,
  );
}
