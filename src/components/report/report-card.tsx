/**
 * The one shape every part of a report is drawn in — the app's answer to
 * `.card` in `page.css`: a raised surface, a left accent naming what kind of
 * part this is, a small caps label, then whatever the part puts inside.
 *
 * The reference page has five accent colours (amber/blue/teal/violet/green,
 * one per part) but this app has no teal token (see `tone.ts`), and content
 * sections were the part painted teal. Rather than borrow `red` — which every
 * other component in this app spends on "something is wrong" — content
 * sections get the neutral accent instead of a sixth invented hue.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type ReportCardKind = 'action' | 'status' | 'content' | 'decisions' | 'next';

const ACCENT: Record<ReportCardKind, string> = {
  action: 'border-l-warning',
  status: 'border-l-info',
  content: 'border-l-b-strong',
  decisions: 'border-l-epic',
  next: 'border-l-success',
};

const LABEL_COLOR: Record<ReportCardKind, string> = {
  action: 'text-warning',
  status: 'text-info',
  content: 'text-t-muted',
  decisions: 'text-epic',
  next: 'text-success',
};

export function ReportCard({
  id,
  kind,
  label,
  children,
  className,
}: {
  id?: string;
  kind: ReportCardKind;
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-testid="report-part"
      data-part-kind={kind}
      className={cn(
        'theme-card flex flex-col gap-4 border border-b-default bg-surface-raised px-5 py-5',
        'border-l-4 scroll-mt-5',
        ACCENT[kind],
        className,
      )}
    >
      <p className={cn('text-xs font-bold uppercase tracking-wide', LABEL_COLOR[kind])}>{label}</p>
      {children}
    </section>
  );
}
