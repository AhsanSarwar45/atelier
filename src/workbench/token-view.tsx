/**
 * The whole token picture for one chat, behind the gauge on its top line.
 *
 * The gauge says how full the window is and nothing else, and it answers the
 * wrong question twice over. First, "128k/200k" does not say what the 128k IS —
 * a chat is not full of anything a reader can act on until it is broken into
 * the conversation, the tool schemas, the memory files and the skills, and only
 * then does "what could I take out" have an answer. Second, the number drops
 * back to almost nothing every time the kit compacts the conversation, so a
 * reader watching the gauge through a long day sees a task that has cost half a
 * billion tokens reading 20k, with nothing on the screen saying otherwise
 * (bw-3ug7).
 *
 * So the panel holds both numbers in front of each other, and says in words
 * which of the two resets. Neither is a price: a token has no dollar figure
 * anywhere in this app (decision 12, docs/agent-workbench.md §8.4f).
 *
 * Everything here is read once, when the panel opens. The window figure comes
 * off the kit's own control channel and the spend off the chat's record on
 * disk — a 30MB record reads in about a tenth of a second, which is a click,
 * not a beat, and neither number moves fast enough to be worth following.
 */
'use client';

import { useEffect, useState } from 'react';

import { Gauge, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { request } from '@/lib/api';
import { reads, TIGHT } from '@/workbench/context-window';
import type { Split, TaskSpend } from '@/workbench/token-picture';
import type { Inside, TokenPicture, Weight, WindowNow } from '@/workbench/window-now';

import { cn } from '@/lib/utils';

import { Overlay, overlayPanel } from '@/components/ui/overlay';


/* ------------------------------------------------------------------ *
 * Reading the numbers out loud.
 * ------------------------------------------------------------------ */

/** A token count the way a reader says one: 940, 128k, 1.2M, 531M. */
export function big(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * A share as a percentage, and never a rounded-down zero: a row reading "0%"
 * beside 4,000 tokens says the row does not matter, which is a different claim
 * from "it is small".
 */
export function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const share = (part / whole) * 100;
  if (share > 0 && share < 1) return '<1%';
  return `${Math.round(share)}%`;
}

/** One segment of the window bar. */
export interface Stripe {
  name: string;
  tokens: number;
  /** Percent of the whole window, ready for a style. */
  width: number;
  /** The room left over rather than something in the window. */
  room: boolean;
}

/**
 * The window drawn as one bar: every filled band in order, then what is left.
 *
 * The room is one segment and not the kit's two ("free space" and the buffer it
 * keeps for compacting), because as a picture they are the same thing — space —
 * and the moment the buffer actually matters is drawn separately, as the mark
 * where the chat will forget itself.
 */
export function stripesOf(w: WindowNow): Stripe[] {
  const bar: Stripe[] = w.pieces.map((p) => ({
    name: p.name,
    tokens: p.tokens,
    width: Math.max(0, p.share * 100),
    room: false,
  }));
  const left = Math.max(0, w.window - w.used);
  if (left > 0) bar.push({ name: 'Remaining', tokens: left, width: (left / w.window) * 100, room: true });
  return bar;
}

/** One line of the four-way split, with what it actually means beside it. */
export interface SplitRow {
  key: string;
  label: string;
  tokens: number;
  note: string;
}

/**
 * A spend split the four ways the kit bills one.
 *
 * A fixed order rather than biggest-first: these four rows are read again every
 * time the panel is opened, and a list that reorders itself has to be re-read
 * from the top each time. Read-back leads because on any conversation past its
 * first few turns it is most of the bill, which is the fact the whole row
 * exists to make obvious.
 */
export function splitRows(s: Split): SplitRow[] {
  return [
    {
      key: 'read',
      label: 'Cached input',
      tokens: s.cacheRead,
      note: '',
    },
    {
      key: 'kept',
      label: 'Cache writes',
      tokens: s.cacheWrite,
      note: '',
    },
    { key: 'sent', label: 'Input', tokens: s.input, note: '' },
    { key: 'written', label: 'Output', tokens: s.output, note: '' },
  ];
}

/**
 * The sentence that tells the two numbers apart.
 *
 * Said in words and not left to the layout, because the whole defect this panel
 * exists for is a reader believing the small number is the whole story.
 */
export function resetLine(spent: TaskSpend | null, drewWindow = true): string {
  const forgot = spent?.forgettings ?? 0;
  const times = forgot === 1 ? 'once' : `${forgot} times`;
  // Points at the picture only when there is one: a chat read from its record
  // has no window drawn above this line, and saying "the window above" sent the
  // reader looking for something that was never there (bw-3ug7.10).
  const context = drewWindow ? 'Context' : 'The context window';
  if (spent === null) return `${context} resets after compaction; total usage does not.`;
  if (forgot === 0) return `${context} has not reset. Total usage does not reset.`;
  return `${context} reset ${times}. Total usage does not reset.`;
}

/* ------------------------------------------------------------------ *
 * Drawing it.
 * ------------------------------------------------------------------ */

/**
 * One colour per band, taken from the theme's own semantic tokens.
 *
 * Not the kit's colours, which are ANSI names for a terminal, and not
 * `--chart-1..5`, which the 10 custom skins never redefine and which would
 * therefore freeze at the default palette under every one of them
 * (src/components/report/tone.ts records the same finding). Complete literal
 * strings, because Tailwind only ships a class it can read as-is.
 */
const BANDS = [
  'bg-primary',
  'bg-[var(--color-info-accent)]',
  'bg-[var(--color-epic-accent)]',
  'bg-[var(--color-success-accent)]',
  'bg-[var(--color-warning-accent)]',
  'bg-[var(--color-destructive-accent)]',
];

const bandColour = (i: number, room: boolean): string => (room ? 'bg-muted' : BANDS[i % BANDS.length]!);

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Panel inset="md" data-testid={testId}>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </Panel>
  );
}

/** A short list of named weights — memory files, servers, tools — or nothing. */
function Weights({ title, rows, of }: { title: string; rows: Weight[]; of: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0">
      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="mt-1 space-y-0.5">
        {rows.slice(0, 6).map((r) => (
          <li key={r.name} className="flex gap-2 text-xs" data-testid="token-weight">
            <span className="truncate text-foreground" title={r.name}>
              {r.name}
            </span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">
              {big(r.tokens)} · {pct(r.tokens, of)}
            </span>
          </li>
        ))}
        {rows.length > 6 && (
          <li className="text-[11px] text-muted-foreground">and {rows.length - 6} more</li>
        )}
      </ul>
    </div>
  );
}

/** What the conversation band itself is made of, when the kit will say. */
function Conversation({ inside }: { inside: Inside }) {
  const parts = [
    { name: 'What the tools answered', tokens: inside.answers },
    { name: 'What the models wrote', tokens: inside.written },
    { name: 'Pictures and pasted files', tokens: inside.attachments },
    { name: 'The calls themselves', tokens: inside.calls },
    { name: 'What was typed', tokens: inside.typed },
    { name: 'Carried in from elsewhere', tokens: inside.carried },
    { name: 'Unattributed', tokens: inside.rest },
  ]
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  if (parts.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-3" data-testid="token-inside">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Weights title="The conversation is made of" rows={parts} of={inside.total} />
        <Weights title="Costliest tools" rows={inside.byTool} of={inside.total} />
        <Weights title="Costliest attachments" rows={inside.byAttachment} of={inside.total} />
      </div>
    </div>
  );
}

/** The window: what is in it this instant, and where it will forget itself. */
function Window({ window: w }: { window: WindowNow }) {
  const bar = stripesOf(w);
  const mark = w.forgetsAt !== null ? Math.min(100, (w.forgetsAt / w.window) * 100) : null;
  return (
    <Card title="Context window" testId="token-window">
      <div className="mt-1 flex items-baseline gap-2 text-sm">
        <span className="font-mono text-foreground" data-testid="token-window-figure">
          {reads(w.used, w.window)}
        </span>
        <span className="text-muted-foreground">{Math.round(w.percent)}% full</span>
        {w.model && <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{w.model}</span>}
      </div>

      <div className="relative mt-2" data-testid="token-bar" data-pieces={bar.length}>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {bar.map((s, i) => (
            <div
              key={s.name}
              className={bandColour(i, s.room)}
              style={{ width: `${s.width}%` }}
              title={`${s.name} · ${s.tokens.toLocaleString()} tokens`}
            />
          ))}
        </div>
        {mark !== null && (
          // Where the conversation gets thrown away and started again from a
          // summary. It is the one moment on this bar that changes what the
          // reader should do next, so it is drawn ON the bar rather than left
          // as a number in a sentence underneath.
          <div
            className="absolute -top-0.5 h-4 w-px bg-foreground"
            style={{ left: `${mark}%` }}
            data-testid="token-forgets-mark"
            title={`Compacts at ${w.forgetsAt?.toLocaleString()} tokens`}
          />
        )}
      </div>

      <ul className="mt-2 space-y-1">
        {bar.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2 text-xs" data-testid="token-piece" data-piece={s.name}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${bandColour(i, s.room)}`} aria-hidden="true" />
            <span className={`truncate ${s.room ? 'text-muted-foreground' : 'text-foreground'}`}>{s.name}</span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">
              {big(s.tokens)} · {pct(s.tokens, w.window)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {w.forgetsAt !== null
          ? `Compacts at ${w.forgetsAt.toLocaleString()} · ${big(Math.max(0, w.forgetsAt - w.used))} remaining`
          : 'Compaction off'}
      </p>

      {(w.memory.length > 0 || w.servers.length > 0 || w.waiting.length > 0) && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border/60 pt-3 sm:grid-cols-3">
          <Weights title="Memory files" rows={w.memory} of={w.window} />
          <Weights title="Tool servers" rows={w.servers} of={w.window} />
          <Weights title="Pending" rows={w.waiting} of={w.window} />
        </div>
      )}

      {w.inside && <Conversation inside={w.inside} />}
    </Card>
  );
}

/** What the whole task has spent, from its first word to now. */
function Spent({ spent }: { spent: TaskSpend }) {
  const rows = splitRows(spent.total);
  return (
    <Card title="Total task usage" testId="token-spent">
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl text-foreground" data-testid="token-spent-total" data-total={spent.total.total}>
          {big(spent.total.total)}
        </span>
        <span className="text-xs text-muted-foreground">
          {spent.turns.toLocaleString()} turns · {spent.toolCalls.toLocaleString()} tool calls ·{' '}
          {spent.helperCount.toLocaleString()} subagents · {spent.forgettings.toLocaleString()} compactions
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.key} data-testid="token-split" data-split={r.key}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-foreground">{r.label}</span>
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">
                {big(r.tokens)} · {pct(r.tokens, spent.total.total)}
              </span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pctWidth(r.tokens, spent.total.total)}%` }} />
            </div>
            {r.note && <p className="mt-0.5 text-[11px] text-muted-foreground">{r.note}</p>}
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
        <Weights
          title="By source"
          rows={[
            { name: 'Current chat', tokens: spent.own.total },
            { name: 'Subagents', tokens: spent.helpers.total },
          ].filter((r) => r.tokens > 0)}
          of={spent.total.total}
        />
        <Weights
          title="Per model"
          rows={spent.models.map((m) => ({ name: m.model, tokens: m.spend.total }))}
          of={spent.total.total}
        />
      </div>
    </Card>
  );
}

const pctWidth = (part: number, whole: number): number => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

/** Why half the picture is missing, in the words the sidecar sent. */
function Missing({ note, testId }: { note: string; testId: string }) {
  return (
    <Panel inset="md" className="text-sm text-muted-foreground" data-testid={testId}>
      {note}
    </Panel>
  );
}

export function TokenView({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [picture, setPicture] = useState<TokenPicture | null>(null);
  const [broke, setBroke] = useState(false);

  useEffect(() => {
    let dropped = false;
    void request(`/api/workbench/tokens?session=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<TokenPicture>) : Promise.reject(new Error(String(r.status)))))
      .then((got) => {
        if (!dropped) setPicture(got);
      })
      .catch(() => {
        if (!dropped) setBroke(true);
      });
    return () => {
      dropped = true;
    };
  }, [sessionId]);

  return (
    <Overlay testId="token-view" label="Tokens" onClose={onClose}>
      {/* The panel stands where the screen ends and scrolls inside itself. It
          used to be one growing box with `overflow-y-auto` and no ceiling, so a
          long chat's picture ran off the bottom of the window with its last
          rows unreachable (bw-3ug7.13). Header stays; only the body moves. */}
      <div className={cn(overlayPanel, 'max-w-3xl')}>
        <div className="flex items-center gap-2 border-b border-border/60 p-4">
          <h2 className="text-base font-semibold text-foreground">Tokens</h2>
          <Button size="xs" variant="ghost" className="ml-auto" data-testid="token-close" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="token-scroll">
        {broke && <Missing note="Token usage unavailable" testId="token-broke" />}
        {!broke && picture === null && <p className="p-3 text-sm text-muted-foreground">Reading…</p>}

        {picture !== null && (
          <>
            {picture.window ? <Window window={picture.window} /> : <Missing note={picture.windowNote ?? 'Context unavailable'} testId="token-no-window" />}

            <p className="text-xs text-muted-foreground" data-testid="token-reset-line">
              {resetLine(picture.spent, picture.window !== null)}
            </p>

            {picture.spent ? <Spent spent={picture.spent} /> : <Missing note={picture.spentNote ?? 'Usage unavailable'} testId="token-no-spend" />}

          </>
        )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * The gauge itself, which is now a way in rather than a read-only number.
 *
 * A real Button inside the badge, the pattern the plan chip already uses: a
 * Badge renders a <span>, and a click handler on a span is reachable by mouse
 * and by nothing else — no tab stop, no Enter, nothing for a screen reader to
 * announce. This chip is the only way into the token picture in the app, so
 * mouse-only would be the only way in (bw-malh.7, bw-3ug7.4).
 */
export function ContextChip({
  used,
  window: room,
  onOpen,
}: {
  used: number;
  window: number;
  onOpen: () => void;
}) {
  return (
    // The hook sits on the pill, not on the button inside it: the line above a
    // conversation is measured by these hooks, and a hook on the inner button
    // reports a box a padding narrower than the one that is actually painted —
    // which would hide the very overlap that check exists to catch (bw-3ug7.9).
    // The button carries its own hook, as the plan chips do.
    <Badge
      variant={used / room >= TIGHT ? 'warning' : 'secondary'}
      appearance="light"
      size="sm"
      data-testid="context-chip"
      data-used={used}
      data-window={room}
      title={`${used.toLocaleString()} of ${room.toLocaleString()} tokens of this conversation are in use\nClick for the whole token picture`}
      className="font-mono"
    >
      <Button
        type="button"
        variant="foreground"
        size="inherit"
        data-testid="context-chip-open"
        aria-label={`Context — ${used.toLocaleString()} of ${room.toLocaleString()} tokens in use. Opens the whole token picture.`}
        className="gap-1 p-0"
        onClick={onOpen}
      >
        {/* Its own mark, like the coins on the cost chip beside it: three bare
            numbers in a row on one line read as one number. */}
        <Gauge />
        {reads(used, room)}
      </Button>
    </Badge>
  );
}
