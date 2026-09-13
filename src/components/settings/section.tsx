/**
 * The parts a settings section is written in: a headed group, and a row that
 * names one setting and holds its control.
 *
 * A row is a label and a sentence on the left and the control on the right,
 * which on a phone drops under them — so every setting on every settings
 * screen is laid out by one rule rather than each panel deciding for itself.
 */
import type { ReactNode } from 'react';

import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

export function SettingsGroup({
  title,
  description,
  children,
  className,
  actions,
  ...rest
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Controls beside the heading: a refresh, an add. */
  actions?: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <section className={cn('mb-8', className)} data-testid={rest['data-testid']}>
      {(title || actions) && (
        <div className="mb-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-t-primary">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-t-tertiary">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <Panel inset="none" className="divide-y divide-border/40">
        {children}
      </Panel>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  stack = false,
  className,
  ...rest
}: {
  label: ReactNode;
  description?: ReactNode;
  /** The control's id, so the label focuses it. */
  htmlFor?: string;
  children?: ReactNode;
  /** Always put the control under the words — for a wide control such as a list or a text box. */
  stack?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div
      data-testid={rest['data-testid']}
      className={cn(
        'flex gap-3 px-3 py-3',
        stack ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor={htmlFor} className="block text-sm font-medium text-t-secondary">
          {label}
        </Label>
        {description && <div className="mt-0.5 text-xs text-t-muted">{description}</div>}
      </div>
      {children && (
        <div className={cn('flex shrink-0 items-center gap-2', stack ? 'w-full' : 'sm:justify-end')}>
          {children}
        </div>
      )}
    </div>
  );
}
