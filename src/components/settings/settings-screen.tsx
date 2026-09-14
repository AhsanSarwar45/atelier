/**
 * A screen made of sections: one bar, a list of the sections, and the open
 * section beside it.
 *
 * On a wide screen the list stands in a column on the left and the section
 * fills the rest. On a phone there is no room for both, so the list is the
 * first screen and a section opens over it, with its own way back — the same
 * swap the agent-files browser makes between its tree and its reader.
 *
 * The open section is the caller's to hold, because it belongs in the address:
 * `/settings?section=accounts` opens the same section a link to it would, and
 * Back steps out of it (docs/designs/app-shell.md §1.7). This component only
 * says which section was pressed.
 *
 * The settings screen and the project's settings are both drawn with it, so
 * the two agree on where the list is, how a section is headed and how a phone
 * moves between them (bw-2t1c.2).
 */
'use client';

import type { ReactNode } from 'react';

import { ChevronRight } from 'lucide-react';

import { BackLink } from '@/components/back-link';
import { Button } from '@/components/ui/button';
import { Row } from '@/components/ui/row';
import { usePhoneScreen } from '@/lib/screen-width';
import { cn } from '@/lib/utils';

export interface SettingsSectionDef {
  id: string;
  label: string;
  /** One line under the label in the list, for a section whose name is not enough. */
  hint?: string;
  icon?: ReactNode;
}

export function SettingsScreen({
  title,
  backHref,
  sections,
  section,
  onOpen,
  children,
  bar,
  backSteps,
  wide,
}: {
  title: string;
  /** How many history entries the arrow steps over; see BackLink. */
  backSteps?: number | (() => number);
  /** The open section fills the body instead of a reading column (the file browser). */
  wide?: boolean;
  /** Where the bar's arrow goes when nothing of ours is behind this screen. */
  backHref: string;
  sections: SettingsSectionDef[];
  /** The open section's id; `null` is the list itself, which only a phone draws on its own. */
  section: string | null;
  /** The reader pressed a section (or, on a phone, the way back to the list: `null`). */
  onOpen: (id: string | null) => void;
  /** The open section's contents. */
  children: ReactNode;
  /** Anything else the bar carries, after the title. */
  bar?: ReactNode;
}) {
  const phone = usePhoneScreen();
  // A wide screen always shows a section: the first one, when the address names none.
  const shown = section ?? (phone ? null : (sections[0]?.id ?? null));
  const open = sections.find((s) => s.id === shown) ?? null;

  return (
    <div data-testid="settings-screen" className="flex h-dvh flex-col overflow-hidden bg-surface-base">
      <div
        data-shell-bar
        data-testid="settings-bar"
        className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 bg-background/80 px-3"
      >
        {phone && open ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
            onClick={() => onOpen(null)}
            data-testid="settings-sections"
          >
            <ChevronRight className="h-4 w-4 rotate-180 opacity-100" />
            <span className="sr-only">All sections</span>
          </Button>
        ) : (
          <BackLink href={backHref} steps={backSteps} />
        )}
        <h1 className="truncate text-lg font-semibold text-t-primary">
          {phone && open ? open.label : title}
        </h1>
        {bar}
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={`${title} sections`}
          data-testid="settings-nav"
          className={cn(
            'w-full shrink-0 overflow-y-auto border-border/40 md:w-56 md:border-r',
            phone && open && 'hidden',
          )}
        >
          <ul className="py-2 md:p-2">
            {sections.map((s) => (
              <li key={s.id}>
                <Row
                  inset="md"
                  radius={phone ? 'none' : 'md'}
                  ruled={phone}
                  selected={!phone && s.id === shown}
                  aria-current={s.id === shown ? 'page' : undefined}
                  data-testid={`settings-section-${s.id}`}
                  onClick={() => onOpen(s.id)}
                  className="flex items-center gap-3"
                >
                  {s.icon && <span className="shrink-0 text-t-muted [&>svg]:size-4">{s.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.label}</span>
                    {s.hint && <span className="block truncate text-xs text-t-muted">{s.hint}</span>}
                  </span>
                  {phone && <ChevronRight className="size-4 shrink-0 text-t-muted" aria-hidden="true" />}
                </Row>
              </li>
            ))}
          </ul>
        </nav>
        <main
          data-testid="settings-body"
          className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto', phone && !open && 'hidden')}
        >
          {open && <div className={cn('mx-auto p-4 sm:p-6', !wide && 'max-w-3xl')}>{children}</div>}
        </main>
      </div>
    </div>
  );
}
