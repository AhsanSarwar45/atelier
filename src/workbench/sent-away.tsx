/**
 * Everything the chat handed to something else, as rows beside the conversation
 * (docs/agent-workbench.md §8.2.7).
 *
 * A work panel, not a subagent panel: the kit's own list of background work
 * names four kinds — a helper given a brief, a command left running, a watch, a
 * scripted run of agents — and all four are work this chat is waiting on, so
 * all four get a row and the kind is a mark on the row rather than a list of
 * its own.
 *
 * The numbers were always arriving and were always thrown away: elapsed, spend
 * and call count come from the kit's own progress messages, and the model from
 * the helper's own words. Nothing here asks for anything new.
 *
 * A row counts its own seconds between the kit's reports, because those arrive
 * about twice a minute and a clock that moves in half-minute jumps reads as a
 * clock that has stopped. The kit's own count wins the moment it arrives: it
 * knows about pauses, and this does not.
 *
 * A finished row goes quiet — dimmed, its live line dropped — and keeps its
 * result, because a row that throws the answer away is a row the reader has to
 * go and find the answer for.
 *
 * The finished ones also go BELOW: what is still running is drawn first and on
 * its own, and the rest sit behind one control that names how many there are.
 * A session that sends off forty helpers used to draw forty rows, and the two
 * still working were somewhere in the middle of them (bw-pl2v.2).
 */
'use client';

import { useEffect, useId, useState } from 'react';

import { Bot, ChevronDown, ChevronRight, Clock, Coins, Eye, SendToBack, Square, Terminal, Workflow } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Row } from '@/components/ui/row';
import { cn } from '@/lib/utils';
import { helperState } from '@/workbench/chat-state';
import { ChatStateChip } from '@/workbench/chat-state-chip';
import { forHowLong } from '@/workbench/elapsed';
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import type { AgentControl, AgentKind, AgentState } from '@/workbench/protocol';
import { isOver } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

export { isOver };

/** How often a running row re-reads the clock. */
const TICK_MS = 1000;

/**
 * What each kind is called on its row, and what it is drawn with.
 *
 * Exported so the sidecar's own words can be checked against it: a kind the
 * driver invents and this does not know draws an empty row.
 */
export const KINDS: Record<AgentKind, { label: string; Icon: typeof Bot }> = {
  helper: { label: 'helper', Icon: Bot },
  command: { label: 'command', Icon: Terminal },
  watch: { label: 'watch', Icon: Eye },
  run: { label: 'run', Icon: Workflow },
};

/** What each state is called, and how loudly it is drawn. Exported for the same reason as the kinds above. */
export const STATES: Record<AgentState, { label: string; variant: 'secondary' | 'warning' | 'destructive' | 'success' }> = {
  running: { label: 'running', variant: 'secondary' },
  waiting: { label: 'waiting on you', variant: 'warning' },
  parked: { label: 'background', variant: 'secondary' },
  done: { label: 'done', variant: 'success' },
  failed: { label: 'failed', variant: 'destructive' },
  stopped: { label: 'stopped', variant: 'secondary' },
};


/**
 * Seconds, rounded to the unit a glance needs.
 *
 * The reading itself is the app's one clock (elapsed.ts) — it started here, and
 * moved out when the chat's own counts turned out to be saying `109s` for the
 * same length of time this column has always called `1m 49s` (bw-jaoz.6). Still
 * exported from here, because this is the name every caller knows it by.
 */
export { forHowLong };

/**
 * Tokens, short enough to sit beside a clock.
 *
 * Rounded rather than exact, because the exact figure is on the row's own title
 * and nobody reads seven digits at a glance.
 */
export function spend(tokens: number): string {
  if (tokens < 1000) return `${Math.max(0, Math.round(tokens))}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * The model, as short as it can be said.
 *
 * The kit answers with the full name it resolved to — `claude-opus-4-5-20251101`
 * — and the column is about 90px wide. The date and the vendor are the parts a
 * reader already knows.
 */
export function modelNamed(model: string | null): string | null {
  if (!model) return null;
  const short = model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(latest|v\d+)$/, '');
  return short || model;
}

/**
 * How long this row has been going, live between the kit's own reports.
 *
 * Exported because the row and the conversation opened from it must say the
 * same number: two accounts of one agent, differing by whatever has happened
 * since the kit last reported, is worse than one.
 */
export function liveSeconds(row: SentAway, now: number): number {
  if (isOver(row.state)) return row.seconds;
  const mine = row.startedAt ? (now - row.startedAt) / 1000 : 0;
  // The kit's count knows about pauses and this one does not, so it wins
  // whenever it is the larger of the two.
  return Math.max(row.seconds, mine);
}

/**
 * One clock for the whole screen, ticking only while something is still going.
 *
 * One, because two of them drift: a row and the pane opened from it each ran
 * their own second and rounded to different numbers, so the row read `2s` while
 * the conversation opened from it read `1s` (measured 2026-08-20). There is one
 * interval and one instant, and a reader joining late joins on the instant
 * everybody else is already on.
 *
 * Only while something runs, because a panel of finished rows that re-renders
 * every second is a panel that costs a frame a second to say nothing.
 */
let sharedNow = 0;
const readers = new Set<(now: number) => void>();
let beat: ReturnType<typeof setInterval> | null = null;

function joinTheClock(read: (now: number) => void): () => void {
  if (!beat) {
    sharedNow = Date.now();
    beat = setInterval(() => {
      sharedNow = Date.now();
      readers.forEach((r) => r(sharedNow));
    }, TICK_MS);
  }
  readers.add(read);
  read(sharedNow);
  return () => {
    readers.delete(read);
    if (readers.size === 0 && beat) {
      clearInterval(beat);
      beat = null;
    }
  };
}

export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => (beat ? sharedNow : Date.now()));
  useEffect(() => (live ? joinTheClock(setNow) : undefined), [live]);
  return now;
}

/**
 * The two exact controls on one running row (docs/agent-workbench.md §8.2.7):
 * stop it, or send it to the background and let it run on. Both are the
 * brand's own.
 *
 * Only what the brand actually has. A control the driver did not name is not
 * drawn — a button that cannot do the thing written on it is worse than no
 * button (decision 13) — and a chat nobody is driving names none of them, which
 * is the truth: there is nothing there to steer with.
 *
 * Nothing is drawn once the work is over, and the background control goes once
 * it is already there: there is no backgrounding a thing that is already in
 * the background.
 *
 * A click that does not land says so. The button coming back to life is what
 * success looks like, so a refused stop that only re-enabled the button would
 * be indistinguishable from a stop that worked — and the reader would walk away
 * believing an agent had been stopped that is still running (bw-7ks.22.34).
 */
export function AgentSteering({
  row,
  sessionId,
  controls,
}: {
  row: SentAway;
  sessionId: string;
  controls: AgentControl[];
}) {
  const [busy, setBusy] = useState<AgentControl | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const canStop = controls.includes('stop');
  const canBackground = controls.includes('park') && row.state !== 'parked';
  if (isOver(row.state) || (!canStop && !canBackground)) return null;

  const act = (what: 'stop' | 'park'): void => {
    setBusy(what);
    setRefused(null);
    // Released as soon as the ask is answered, not held until the row changes
    // under it: what happened is the kit's word, carried on the row's own
    // state, and a button waiting for it would never come back from a refusal.
    void sendCommand({ type: what === 'stop' ? 'agent.stop' : 'agent.park', sessionId, agentId: row.id })
      .catch((e: unknown) =>
        setRefused(
          `${what === 'stop' ? 'Not stopped' : 'Not sent to the background'}. ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
      .finally(() => setBusy(null));
  };

  return (
    <div className="border-t border-border/60">
      <div data-testid="sent-away-steer" className="flex items-center gap-1 px-2 py-1">
        {canBackground && (
          <Button
            size="xs"
            variant="ghost"
            data-testid="sent-away-park"
            disabled={busy !== null}
            title="Run in background"
            onClick={() => act('park')}
          >
            <SendToBack className="h-3 w-3" aria-hidden="true" />
            Background
          </Button>
        )}
        {canStop && (
          <Button
            size="xs"
            variant="ghost"
            data-testid="sent-away-stop"
            disabled={busy !== null}
            title="Stop subagent"
            onClick={() => act('stop')}
          >
            <Square className="h-3 w-3" aria-hidden="true" />
            Stop
          </Button>
        )}
      </div>
      {refused && (
        <p data-testid="sent-away-steer-error" className="px-2 pb-1 text-[11px] text-red-500">
          {refused}
        </p>
      )}
    </div>
  );
}

function AgentRow({
  row,
  items,
  now,
  sessionId,
  controls,
  onOpen,
}: {
  row: SentAway;
  items: readonly TranscriptItem[];
  now: number;
  sessionId: string;
  controls: AgentControl[];
  onOpen?: (id: string) => void;
}) {
  const { label: kind, Icon } = KINDS[row.kind];
  const model = modelNamed(row.model);
  const over = isOver(row.state);

  return (
    <Panel
      role="listitem"
      inset="none"
      data-testid="sent-away-row"
      data-agent={row.id}
      data-kind={row.kind}
      data-state={row.state}
      className={cn(
        'text-xs',
        // Over is quiet: the eye belongs on whatever is still moving.
        over && 'opacity-60',
      )}
    >
      {/* The whole row is the way in, not a mark on it: the row IS the thing,
          and a target the size of one word beside it is a target the reader
          misses. The padding lives here rather than on the box for the same
          reason — a click anywhere in the row is a click on the row. */}
      <Row
        inset="sm"
        data-testid="sent-away-open"
        title={row.what ? `Open ${row.what}` : `Open this ${kind}`}
        onClick={onOpen ? () => onOpen(row.id) : undefined}
        className="flex flex-col gap-1"
      >
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* What kind of thing this is, said in words rather than left to the
            icon alone — a lucide glyph names nothing to a sighted reader who
            has not learned the four of them by heart. */}
        <span
          data-testid="sent-away-kind"
          className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {kind}
        </span>
        {/* Which agent definition the kit was asked for, when it said one —
            null for a command or a watch, and for a helper the kit never
            named, and drawn as nothing then rather than as a placeholder that
            claims to know. Capped and truncated, its full name on the title,
            the same bargain the model further down makes: this column is
            narrow and a name like general-purpose does not fit it whole. */}
        {row.agentType && (
          <span
            data-testid="sent-away-agent-type"
            className="max-w-16 shrink-0 truncate text-[10px] font-medium text-foreground/80"
            title={row.agentType}
          >
            {row.agentType}
          </span>
        )}
        <span data-testid="sent-away-what" className="min-w-0 flex-1 truncate" title={row.what}>
          {row.what || kind}
        </span>
      </div>

      {/* The three numbers, in the order they are asked for: which model, how
          long, what it has spent. Each wears its own mark — three bare numbers
          in a row read as one (bw-7ks.22.13). */}
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {model && (
          <span data-testid="sent-away-model" className="max-w-24 shrink truncate" title={row.model ?? undefined}>
            {model}
          </span>
        )}
        <span data-testid="sent-away-for" className="flex shrink-0 items-center gap-1">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {forHowLong(liveSeconds(row, now))}
        </span>
        <span
          data-testid="sent-away-spend"
          className="flex shrink-0 items-center gap-1"
          title={`${row.tokens.toLocaleString()} tokens over ${row.calls} call${row.calls === 1 ? '' : 's'}`}
        >
          <Coins className="h-3 w-3" aria-hidden="true" />
          {spend(row.tokens)}
        </span>
        {row.calls > 0 && (
          <span data-testid="sent-away-calls" className="shrink-0">
            {row.calls} call{row.calls === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Where it stands and what it is on, in the one mark the reader already
          knows from the chat's own line and from the row in the list. It is the
          whole of what this card says about the helper's own work now that the
          transcript no longer draws that work inline — so it settles rather
          than vanishing when the helper finishes, and it reads its own rows
          rather than the kit's half-minute progress (bw-pukk.2). */}
      <ChatStateChip
        state={helperState(row, items)}
        size="inline"
        testId="sent-away-state"
        className="text-[11px]"
      />
      {/* Its answer once it is done. Never beside the present tense of a thing
          that has finished, which is why the mark above settles first. */}
      {over && row.result && (
        <p data-testid="sent-away-result" className="line-clamp-2 text-[11px] text-muted-foreground" title={row.result}>
          {row.result}
        </p>
      )}
      </Row>
      <AgentSteering row={row} sessionId={sessionId} controls={controls} />
    </Panel>
  );
}

export interface SentAwayPanelProps {
  agents: SentAway[];
  /**
   * The conversation's own rows, which is where a helper's live line is read
   * from: its rows carry the call that sent it, and they arrive as they happen
   * rather than twice a minute (see {@link helperState}).
   */
  items: readonly TranscriptItem[];
  /** Whose chat these belong to; the steering acts on it. */
  sessionId: string;
  /** Which steering controls this chat's brand has. None is a real answer. */
  controls: AgentControl[];
  /** Opening one: its own conversation, which is the row's whole point. */
  onOpen?: (id: string) => void;
}

/**
 * What the control under the running rows says.
 *
 * It carries its own count, because the reader's question before opening it is
 * how many there are, and a bare chevron answers that with nothing. It says
 * *finished* rather than naming one of the three states behind it: `done`,
 * `failed` and `stopped` all live in there, and every row still wears its own
 * word once it is open.
 */
export function finishedLabel(showing: boolean, count: number): string {
  const verb = showing ? 'Hide' : 'Show';
  return `${verb} ${count} completed`;
}

export function SentAwayPanel({ agents, items, sessionId, controls, onOpen }: SentAwayPanelProps) {
  const now = useNow(agents.some((a) => !isOver(a.state)));
  // Shut on every mount, and deliberately not remembered: what the reader wants
  // on opening a chat is what is still moving in it, and a rail that comes back
  // with forty finished helpers in it is the rail this split was cut to fix.
  const [showingFinished, setShowingFinished] = useState(false);
  const finishedId = useId();

  if (agents.length === 0) return null;

  // Oldest-first within each group, which is the order they were sent in
  // (fold.ts appends). The split groups them; it does not sort them.
  const running = agents.filter((a) => !isOver(a.state));
  const finished = agents.filter((a) => isOver(a.state));

  const draw = (row: SentAway) => (
    <AgentRow
      key={row.id}
      row={row}
      items={items}
      now={now}
      sessionId={sessionId}
      controls={controls}
      onOpen={onOpen}
    />
  );

  return (
    <div
      data-testid="sent-away-panel"
      data-rows={agents.length}
      data-running={running.length}
      data-finished={finished.length}
      className="flex flex-col gap-1.5"
    >
      {/* Always drawn, even with nothing in it: an empty list under a control
          reading "show the 3 that have finished" says where they will land. */}
      <div role="list" data-testid="sent-away-running" className="flex flex-col gap-1.5">
        {running.map(draw)}
      </div>

      {finished.length > 0 && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showingFinished}
            aria-controls={finishedId}
            data-testid="toggle-stopped-agents"
            data-showing={showingFinished}
            onClick={() => setShowingFinished((was) => !was)}
            className="h-auto w-full justify-start gap-1.5 px-1 py-1 text-[11px] font-normal text-muted-foreground hover:bg-muted/40"
          >
            {showingFinished ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 truncate">{finishedLabel(showingFinished, finished.length)}</span>
          </Button>
          {/* Kept mounted so its rows keep their result and their stopped clock,
              and hidden with the utility rather than the `hidden` attribute:
              `display:flex` from the class beside it wins over preflight's
              `[hidden]` rule, so the attribute alone would hide nothing. */}
          <div
            role="list"
            id={finishedId}
            data-testid="sent-away-stopped"
            className={cn('flex-col gap-1.5', showingFinished ? 'flex' : 'hidden')}
          >
            {finished.map(draw)}
          </div>
        </>
      )}
    </div>
  );
}
