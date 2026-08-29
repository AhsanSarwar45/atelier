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
import { NOT_PHONE_SCREEN } from '@/lib/screen-width';
import { cn } from '@/lib/utils';
import { byJob, jobTitle } from '@/workbench/cards-by-job';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import { GitView } from '@/workbench/git-view';
import { useKnownCardStatuses } from '@/workbench/known-cards';
import type { AgentControl } from '@/workbench/protocol';
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
    setOpen(chosen === null ? window.matchMedia(NOT_PHONE_SCREEN).matches : chosen !== '0');
  }, []);

  const flip = useCallback(() => {
    setOpen((was) => {
      localStorage.setItem(RIGHT_RAIL, was ? '0' : '1');
      return !was;
    });
  }, []);

  return [open, flip];
}

/** Where the rail's choice of view is remembered between visits. */
const GIT_VIEW = 'workbench.git-panel';

/**
 * Whether the rail is showing Git rather than what this chat has touched, and
 * remembered (bw-8dp8.5).
 *
 * Remembered for the browser and not for one chat, like the rail's own
 * open-or-shut above and like the kind filter's switches: it is a way of
 * looking, and a manager who works out of this panel wants it there in the next
 * chat too, not just the one he last pressed the button in (bw-qdim).
 *
 * Written where it is CHANGED for exactly the reason the rail above is: an
 * effect that mirrors state back into storage runs once with the value the
 * screen started at, and overwrites what was remembered before the effect that
 * reads it has run.
 *
 * Shut by default, which the rail itself is not. The rail asks the screen's
 * width, because a wide screen has room for a column beside the conversation
 * either way; this asks nothing, because a chat nobody has pressed Git in
 * should open on the chat.
 */
export function useGitPanel(): [boolean, () => void] {
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    setShowing(localStorage.getItem(GIT_VIEW) === '1');
  }, []);

  const flip = useCallback(() => {
    setShowing((was) => {
      localStorage.setItem(GIT_VIEW, was ? '0' : '1');
      return !was;
    });
  }, []);

  return [showing, flip];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/**
 * The two things the rail can be showing. One column, two views, because a
 * second column beside this one leaves a phone with no conversation on it.
 */
export type RailView = 'chat' | 'git';

export interface ChatRightRailProps {
  projectId: string | null;
  /** Every card this chat has touched, in the order it touched them. */
  cards: string[];
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
  /** Which view is drawn. What this chat has touched, unless Git was asked for. */
  view?: RailView;
  /** The project's working directory — what every git call in the Git view runs against. */
  projectPath?: string | null;
  /** Width of the in-row desktop column; the phone sheet stays 288px wide. */
  desktopWidth: number;
  /** Pointer is moving the desktop divider, so the column must follow it immediately. */
  resizing?: boolean;
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
  agents,
  items,
  sessionId,
  agentControls,
  onOpenAgent,
  open,
  view = 'chat',
  projectPath = null,
  desktopWidth,
  resizing = false,
  onToggle,
}: ChatRightRailProps) {
  const jobs = useMemo(() => byJob(cards), [cards]);
  const cardStatuses = useKnownCardStatuses(projectPath);
  const empty = cards.length === 0 && agents.length === 0;
  return (
    <div
      data-testid="chat-right-rail"
      data-open={open}
      data-view={view}
      data-cards={jobs.length}
      data-pieces={cards.length}
      style={{ '--chat-right-rail-width': `${desktopWidth}px` } as React.CSSProperties}
      className={cn(
        'z-30 flex shrink-0 flex-col overflow-hidden border-border/60 bg-background',
        !resizing && 'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        open
          ? // A sheet down the whole right edge on a phone, as tall as the
            // screen under the bars and hard against the side it opens from —
            // and on a wide screen, today's column, in the row and bordered on
            // the one side that touches it.
            cn(
              'fixed inset-y-0 right-0 z-50 w-72 max-w-[85vw] border-l shadow-2xl',
              'md:static md:inset-auto md:z-30 md:h-full md:w-[var(--chat-right-rail-width)] md:max-w-none md:shadow-none',
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
          'flex min-h-0 w-72 flex-1 flex-col divide-y divide-border/60 overflow-y-auto md:w-full',
          'transition-opacity duration-150 ease-out motion-reduce:transition-none',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
          {/* Only on a phone: on a wide screen this is a column of the row and
              the button on the bar is in plain sight above it (bw-81wt.30). */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 md:hidden">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {view === 'git' ? 'Git' : 'This chat'}
            </h2>
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
          {view === 'git' && <GitView path={projectPath} />}

          {view === 'chat' && (
            <>
          {/* First in the column, and a fixed few lines of it. The helpers used
              to sit here because they are the part that moves — but they are
              also the part that grows, and by the fiftieth of them the cards
              this chat has touched had been pushed off the bottom of the rail
              (bw-pl2v.1). Wrapped chips are one short block whatever the
              session has done; the list below them is not. */}
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
                    status={cardStatuses.get(job.id)}
                    size="sm"
                    title={jobTitle(job)}
                  />
                ))}
              </div>
            </Section>
          )}

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

          {empty && (
            <p className="px-3 py-3 text-xs text-muted-foreground" data-testid="rail-empty">
              Nothing from this chat yet.
            </p>
          )}
            </>
          )}
      </div>
    </div>
  );
}
