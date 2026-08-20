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
 * Shut, it is a thin edge with a handle, so the way back is where the rail was
 * rather than in a toolbar the reader has to go looking through. The choice is
 * remembered for the browser rather than for one chat: it is a way of looking,
 * the same reason the kind filter's switches are (bw-qdim).
 *
 * It folds rather than jumps: the width moves and the eye follows the edge, so
 * the transcript is not two different widths on two consecutive frames. Anyone
 * who asked their machine for less motion gets the two ends and nothing between
 * them (bw-7ks.22.12).
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PanelRight, PanelRightClose } from 'lucide-react';

import { BeadChip } from '@/components/bead-chip-row';
import { cn } from '@/lib/utils';
import { byJob, jobTitle } from '@/workbench/cards-by-job';
import type { SentAway } from '@/workbench/fold';
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
  /** Opening one of them onto its own conversation. */
  onOpenAgent: (id: string) => void;
  open: boolean;
  onToggle: () => void;
}

export function ChatRightRail({ projectId, cards, reports, agents, onOpenAgent, open, onToggle }: ChatRightRailProps) {
  const jobs = useMemo(() => byJob(cards), [cards]);
  const empty = cards.length === 0 && reports.length === 0 && agents.length === 0;
  return (
    <div
      data-testid="chat-right-rail"
      data-open={open}
      data-cards={jobs.length}
      data-pieces={cards.length}
      className={cn(
        'z-30 flex h-full shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background',
        // The fold is the width moving, so the eye follows the edge instead of
        // finding the column somewhere else on the next frame. The content keeps
        // its own width and is clipped by this, or the chips would reflow into a
        // narrower and narrower column all the way down (bw-7ks.22.12).
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
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
          {/* First in the column because it is the only part of it that moves.
              Cards and reports are a record and will still be there; a helper
              that has been going four minutes is the thing the reader opened
              this rail to look at (§8.2.7). */}
          {agents.length > 0 && (
            <Section title="Sent away">
              <SentAwayPanel agents={agents} onOpen={onOpenAgent} />
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
