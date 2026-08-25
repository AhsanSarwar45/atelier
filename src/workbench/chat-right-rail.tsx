/**
 * The chat's own second column: what this conversation has touched and what it
 * produced, beside the conversation instead of crammed onto the one line above
 * it. What it has spent stays on that line, where a reader watching it work can
 * see the number without opening anything (bw-7ks.22.13).
 *
 * The cards used to ride on the open chat's own line, which is a row, and a row
 * is the axis there is least of: twenty-six of them drew 2277px inside a pane
 * about 700px wide and squeezed the words naming the agent to 37px (bw-p61.3).
 * A column has height nobody is competing for, so all of them are drawn and
 * none of them is a count — docs/agent-workbench.md §8.2.1, §8.2.6.
 *
 * The way in and out is a button on the bar above, mirroring the one that
 * opens the chat list on the other edge — not a handle built into the rail
 * itself, which used to make this the one panel in the shell whose door was
 * hidden inside the room (bw-81wt.5). The choice of open-or-shut is still
 * remembered for the browser rather than for one chat: it is a way of
 * looking, the same reason the kind filter's switches are (bw-qdim).
 *
 * On a wide screen it still folds in place, part of the row: the width moves
 * and the eye follows the edge, so the transcript is not two different widths
 * on two consecutive frames. On a phone there is no room to fold anything —
 * open, it is a sheet down the whole right edge, the height of the whole screen
 * and over the bars, with a cross inside it and the rest dimmed and tappable
 * (bw-81wt.30). It floated as a small card clear of the top and bottom before
 * that, which read as a stray box rather than a panel. Shut, it takes no width
 * at all rather than leaving a sliver behind (bw-81wt.5). Anyone who asked
 * their machine for less motion gets the two ends and nothing between them
 * (bw-7ks.22.12).
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { X } from 'lucide-react';

import { BeadChip } from '@/components/bead-chip-row';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { byJob, jobTitle } from '@/workbench/cards-by-job';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import type { AgentControl } from '@/workbench/protocol';
import { ReportChip } from '@/workbench/report-view';
import { SentAwayPanel } from '@/workbench/sent-away';

/** Where the rail's open-or-shut is remembered between visits. */
const RIGHT_RAIL = 'workbench.right-rail';

/**
 * Open unless he shut it, and remembered.
 *
 * Written where it is CHANGED, never mirrored from an effect: an effect that
 * writes the state back runs once with the value the screen started at and
 * overwrites what was remembered before the effect that reads it has run — the
 * fault that lost the reader's kind filter on every reload (bw-qdim).
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
  /** Everything it handed to something else, oldest first (§8.2.7). */
  agents: SentAway[];
  /** The conversation's own rows; a helper's card reads its live line from them. */
  items: readonly TranscriptItem[];
  /** Whose chat these belong to; the steering on a row acts on it. */
  sessionId: string;
  /** Which steering controls this chat's brand has for them. None is a real answer. */
  agentControls: AgentControl[];
  /** Opening one of them onto its own conversation. */
  onOpenAgent: (id: string) => void;
  open: boolean;
  /**
   * Shutting it. The button that opens it is on the bar above (bw-81wt.5), and
   * on a phone that bar is behind this sheet — so the same call is what the
   * cross inside the sheet does (bw-81wt.30).
   */
  onToggle: () => void;
}

export function ChatRightRail({
  projectId,
  cards,
  reports,
  agents,
  items,
  sessionId,
  agentControls,
  onOpenAgent,
  open,
  onToggle,
}: ChatRightRailProps) {
  const jobs = useMemo(() => byJob(cards), [cards]);
  const empty = cards.length === 0 && reports.length === 0 && agents.length === 0;
  return (
    <div
      data-testid="chat-right-rail"
      data-open={open}
      data-cards={jobs.length}
      data-pieces={cards.length}
      className={cn(
        'z-30 flex shrink-0 flex-col overflow-hidden border-border/60 bg-background',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        open
          ? // A sheet down the whole right edge on a phone, as tall as the
            // screen under the bars and hard against the side it opens from —
            // and on a wide screen, today's column, in the row and bordered on
            // the one side that touches it.
            cn(
              'fixed inset-y-0 right-0 z-50 w-72 max-w-[85vw] border-l shadow-2xl',
              'md:static md:inset-auto md:z-30 md:h-full md:w-72 md:max-w-none md:shadow-none',
            )
          : // Shut, it takes no width at all, on a wide screen as much as on
            // a phone. It used to keep a thin edge on a desktop because the
            // edge WAS the handle; the handle is on the bar now, so what was
            // left was two centimetres of bordered nothing down the side of
            // every wide chat (bw-81wt.17).
            'h-full w-0',
      )}
    >
      {/* Mounted whether or not it is open: a panel that unmounts on the way out
          has nothing left to animate, and the fold would be a jump with a delay
          in front of it. */}
      <div
        aria-hidden={!open}
        data-testid="chat-right-rail-body"
        className={cn(
          'flex min-h-0 w-72 flex-1 flex-col divide-y divide-border/60 overflow-y-auto',
          'transition-opacity duration-150 ease-out motion-reduce:transition-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
          {/* Only on a phone: on a wide screen this is a column of the row and
              the button on the bar is in plain sight above it (bw-81wt.30). */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 md:hidden">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">This chat</h2>
            <Button
              size="sm"
              mode="icon"
              variant="ghost"
              aria-label="Close what this chat has touched"
              data-testid="chat-right-rail-close"
              onClick={onToggle}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {/* First in the column because it is the only part of it that moves.
              Cards and reports are a record and will still be there; a helper
              that has been going four minutes is the thing the reader opened
              this rail to look at (§8.2.7). */}
          {agents.length > 0 && (
            <Section title="Sent away">
              <SentAwayPanel
                agents={agents}
                items={items}
                sessionId={sessionId}
                controls={agentControls}
                onOpen={onOpenAgent}
              />
            </Section>
          )}

          {jobs.length > 0 && (
            <Section title="Cards it has touched">
              {/* One chip per JOB, and all of them: the column exists so nothing
                  has to be hidden behind a count (§8.2.1), and a job's pieces
                  are folded into it because a dozen chips reading bw-uiyz.N say
                  one thing a dozen times (bw-7ks.22.11). */}
              <div className="flex flex-wrap gap-1" data-testid="rail-cards">
                {jobs.map((job) => (
                  <BeadChip
                    key={job.id}
                    id={job.id}
                    projectId={projectId}
                    size="sm"
                    title={jobTitle(job)}
                  />
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

          {empty && (
            <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="rail-empty">
              Nothing from this chat yet.
            </p>
          )}
      </div>
    </div>
  );
}
