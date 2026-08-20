/**
 * The chat's own second column: what this conversation has touched, what it
 * produced and what it cost, beside the conversation instead of crammed onto
 * the one line above it.
 *
 * The cards used to ride on the open chat's own line, which is a row, and a row
 * is the axis there is least of: twenty-six of them drew 2277px inside a pane
 * about 700px wide and squeezed the words naming the agent to 37px (bw-p61.3).
 * A column has height nobody is competing for, so all of them are drawn and
 * none of them is a count — docs/agent-workbench.md §8.2.1, §8.2.6.
 *
 * Shut, it is a thin edge with a handle, so the way back is where the rail was
 * rather than in a toolbar the reader has to go looking through. The choice is
 * remembered for the browser rather than for one chat: it is a way of looking,
 * the same reason the "show everything" switch is (§8.2.4).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { PanelRight, PanelRightClose } from 'lucide-react';

import { BeadChip } from '@/components/bead-chip-row';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { reads, TIGHT } from '@/workbench/context-window';
import type { Cost } from '@/workbench/protocol';
import { ReportChip } from '@/workbench/report-view';

/** Where the rail's open-or-shut is remembered between visits. */
const RIGHT_RAIL = 'workbench.right-rail';

/**
 * Open unless he shut it, and remembered.
 *
 * Written where it is CHANGED, never mirrored from an effect: an effect that
 * writes the state back runs once with the value the screen started at and
 * overwrites what was remembered before the effect that reads it has run — the
 * fault that lost the "show everything" choice on every reload (§8.2.4).
 */
export function useRightRail(): [boolean, () => void] {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    // His own choice beats everything. With no choice made, a wide screen has
    // room for a column beside the conversation and a phone has not — a rail
    // that opens over the transcript on first sight is a rail he shuts once and
    // then reads the app around.
    const chosen = localStorage.getItem(RIGHT_RAIL);
    setOpen(chosen === null ? window.matchMedia('(min-width: 768px)').matches : chosen !== '0');
  }, []);

  const flip = useCallback(() => {
    setOpen((was) => {
      localStorage.setItem(RIGHT_RAIL, was ? '0' : '1');
      return !was;
    });
  }, []);

  return [open, flip];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export interface ChatRightRailProps {
  projectId: string | null;
  /** Every card this chat has touched, in the order it touched them. */
  cards: string[];
  /** The reports this chat's work produced. */
  reports: { project: string; slug: string; title: string }[];
  /** What the conversation has cost so far, in the brand's own currency. */
  cost: Cost | null;
  /** How much of the agent's memory this conversation is using. */
  context: { used: number; window: number } | null;
  open: boolean;
  onToggle: () => void;
}

export function ChatRightRail({ projectId, cards, reports, cost, context, open, onToggle }: ChatRightRailProps) {
  const empty = cards.length === 0 && reports.length === 0 && !cost && !context;
  return (
    <div
      data-testid="chat-right-rail"
      data-open={open}
      data-cards={cards.length}
      className={cn(
        'z-30 flex h-full shrink-0 flex-col border-l border-border/60 bg-background',
        // Open on a narrow screen, the transcript is what must stay readable, so
        // the rail lies over it and a click outside puts it away — the same
        // bargain the list of chats makes on the other side.
        open ? 'absolute inset-y-0 right-0 w-72 shadow-xl md:relative md:shadow-none' : 'relative w-8',
      )}
    >
      <button
        type="button"
        data-testid="chat-right-rail-toggle"
        aria-label={open ? 'Hide what this chat has touched' : 'Show what this chat has touched'}
        aria-expanded={open}
        title={open ? 'Hide what this chat has touched' : 'Show what this chat has touched'}
        onClick={onToggle}
        className={cn(
          'flex shrink-0 items-center gap-2 text-muted-foreground hover:text-foreground',
          // Shut, the handle IS the rail: the whole edge is the way back in.
          open ? 'h-10 w-full justify-end border-b border-border/60 px-3' : 'h-full w-full justify-center',
        )}
      >
        {open ? (
          <PanelRightClose className="h-4 w-4" aria-hidden="true" />
        ) : (
          <PanelRight className="h-4 w-4" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="flex min-h-0 flex-1 flex-col divide-y divide-border/60 overflow-y-auto">
          {cards.length > 0 && (
            <Section title="Cards it has touched">
              {/* One per line and every one of them: this is the column the
                  chips were moved here to get (§8.2.1). */}
              <div className="flex flex-wrap gap-1" data-testid="rail-cards">
                {cards.map((id) => (
                  <BeadChip key={id} id={id} projectId={projectId} size="sm" />
                ))}
              </div>
            </Section>
          )}

          {reports.length > 0 && (
            <Section title="Reports it produced">
              <div className="flex flex-wrap gap-1" data-testid="rail-reports">
                {reports.map((r) => (
                  <ReportChip key={`${r.project}/${r.slug}`} project={r.project} slug={r.slug} title={r.title} />
                ))}
              </div>
            </Section>
          )}

          {(context || cost) && (
            <Section title="What it has cost">
              <div className="flex flex-wrap items-center gap-2">
                {context && (
                  <Badge
                    variant={context.used / context.window >= TIGHT ? 'warning' : 'secondary'}
                    appearance="light"
                    size="sm"
                    data-testid="context-chip"
                    data-used={context.used}
                    data-window={context.window}
                    title={`${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens of this conversation are in use`}
                    className="font-mono"
                  >
                    {reads(context.used, context.window)}
                  </Badge>
                )}
                {cost && (
                  <Badge variant="secondary" appearance="light" size="sm" data-testid="cost-chip" className="font-mono">
                    {costLabel(cost)}
                  </Badge>
                )}
              </div>
            </Section>
          )}

          {empty && (
            <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="rail-empty">
              Nothing from this chat yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Money on the brands that bill in money, tokens on the ones that do not. */
export function costLabel(cost: Cost): string {
  return cost.kind === 'usd' ? `$${cost.usd.toFixed(4)}` : `${cost.total.toLocaleString()} tokens`;
}
