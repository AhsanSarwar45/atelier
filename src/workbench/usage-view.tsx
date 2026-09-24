/**
 * Plan usage details, behind the chip on the chat's top line.
 *
 * The chip answers one question — how much of the five-hour window is gone —
 * because that is the one that decides whether to start another agent in the
 * next minute. Everything else a reader eventually wants (the week, the model
 * the week is scoped to, credits, and what the spending is going ON) lives
 * here, one click away, rather than crowding a line that also has to carry the
 * agent, the folder and the cards (bw-malh).
 *
 * The figure is the ACCOUNT'S, so no screen here reads it: the sidecar keeps it
 * fresh on a beat of its own and pushes it to every open page, which is what
 * makes a chat sitting silent show the same number as the one being worked in
 * (live.ts `usePlanUsage`, bw-dmoe).
 */
'use client';

import { RotateCcw, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Tooltip } from '@/components/ui/tooltip';
import { usePlanUsage } from '@/workbench/live';
import { CHIP_GAP } from '@/workbench/what-it-runs';
import type { Brand } from '@/workbench/protocol';
import {
  clearsReads,
  clockReads,
  expiryReads,
  percentReads,
  sessionChipReads,
  type Driving,
  type PlanUsage,
  type PlanReset,
  type PlanResets,
  type PlanWindow,
  type ResetOutcome,
  type Severity,
  untilReads,
  weekChipReads,
  windowReads,
} from '@/workbench/plan-usage';

import { request } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Overlay, overlayPanel } from '@/components/ui/overlay';

/* ------------------------------------------------------------------ *
 * Drawing it.
 * ------------------------------------------------------------------ */

/** One colour per state of trouble, taken from the theme rather than spelled here. */
const BAR: Record<Severity, string> = {
  normal: 'bg-primary',
  warning: 'bg-[var(--color-warning-accent)]',
  critical: 'bg-destructive',
};

export function severityVariant(severity: Severity): 'secondary' | 'warning' | 'destructive' {
  return severity === 'critical' ? 'destructive' : severity === 'warning' ? 'warning' : 'secondary';
}

function Window({ window: w, now }: { window: PlanWindow; now: Date }) {
  const clock = clockReads(w.resetsAt);
  const until = untilReads(w.resetsAt, now);
  return (
    <div data-testid="usage-window" data-window={w.key} data-percent={w.percent ?? ''} data-severity={w.severity}>
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-foreground">{w.label}</span>
        <span className="ml-auto font-mono text-foreground">{percentReads(w.percent)}</span>
      </div>
      {/* The bar is what a percentage is FOR: three windows read side by side
          are compared by eye, not by arithmetic. */}
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${BAR[w.severity]}`} style={{ width: `${Math.min(100, Math.max(0, w.percent ?? 0))}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {clock ? `Resets ${clock}${until ? ` · in ${until}` : ''}` : 'No reset time given'}
      </p>
    </div>
  );
}

function Names({ title, rows }: { title: string; rows: { name: string; pct: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <Panel className="min-w-0" inset="md">
      <h4 className="text-xs font-medium text-foreground">{title}</h4>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <Tooltip
            key={r.name}
            side="bottom"
            label={`${readableName(r.name)} appeared in ${r.pct}% of requests during this period.`}
          >
            <li
              tabIndex={0}
              className="flex gap-2 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${readableName(r.name)}: ${r.pct}% of requests`}
            >
              <span className="truncate text-foreground">{readableName(r.name)}</span>
              <span className="ml-auto shrink-0 font-mono text-muted-foreground">{r.pct}%</span>
            </li>
          </Tooltip>
        ))}
      </ul>
    </Panel>
  );
}

const TRAIT_HELP: Record<string, { label: string; detail: string }> = {
  cache_miss: {
    label: 'Requests without cached context',
    detail: 'Requests that could not reuse cached conversation context.',
  },
  long_context: {
    label: 'Long context requests',
    detail: 'Requests from conversations with a large amount of prior context.',
  },
  subagent_heavy: {
    label: 'Requests using subagents',
    detail: 'Requests from sessions that delegated work to subagents.',
  },
  high_parallel: {
    label: 'Parallel agent tasks',
    detail: 'Requests from sessions that ran several agent tasks at the same time.',
  },
  cron: {
    label: 'Scheduled task requests',
    detail: 'Requests started by scheduled tasks.',
  },
};

/** Turn identifiers such as `general-purpose` into labels meant for people. */
export function readableName(name: string): string {
  return name
    .trim()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'devtools' ? 'DevTools' : part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function Trait({ trait }: { trait: Driving['traits'][number] }) {
  const copy = TRAIT_HELP[trait.key] ?? {
    label: trait.label || readableName(trait.key),
    detail: 'Requests with this usage pattern.',
  };
  const explanation = `${copy.detail} ${trait.pct}% of requests matched this pattern. Percentages can overlap.`;
  return (
    <Tooltip label={explanation} side="bottom" align="start">
      <Panel
        tabIndex={0}
        className="outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="usage-trait"
        data-trait={trait.key}
        aria-label={`${copy.label}: ${trait.pct}% of requests. ${copy.detail}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 text-xs font-medium text-foreground">{copy.label}</span>
          <span className="ml-auto shrink-0 font-mono text-sm font-semibold text-foreground">{trait.pct}%</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">of requests</p>
      </Panel>
    </Tooltip>
  );
}

function Spending({ driving }: { driving: Driving }) {
  const span = driving.span === 'day' ? 'Last 24 hours' : 'Last 7 days';
  return (
    <Panel inset="md" data-testid="usage-driving" data-span={driving.span}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">{span}</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {driving.requests.toLocaleString()} requests · {driving.sessions.toLocaleString()} sessions
        </span>
      </div>
      {driving.traits.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <h4 className="text-xs font-medium text-foreground">Request patterns</h4>
            <span className="text-[11px] text-muted-foreground">Percentages can overlap</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {driving.traits.map((trait) => <Trait key={trait.key} trait={trait} />)}
          </div>
        </div>
      )}
      {[driving.agents, driving.skills, driving.plugins, driving.servers].some((rows) => rows.length > 0) && (
        <div className="mt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <h4 className="text-xs font-medium text-foreground">Tools used</h4>
            <span className="text-[11px] text-muted-foreground">Share of requests</span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Names title="Agent types" rows={driving.agents} />
            <Names title="Skills" rows={driving.skills} />
            <Names title="Plugins" rows={driving.plugins} />
            <Names title="Tool servers" rows={driving.servers} />
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Usage resets.
 * ------------------------------------------------------------------ */

/** What using a reset now would refill, and how much of each window is spent. */
function spentReads(reset: PlanReset, windows: PlanWindow[]): string | null {
  const spent = reset.clears
    .map((key) => windows.find((w) => w.key === key))
    .filter((w): w is PlanWindow => !!w && w.percent !== null)
    .map((w) => `${percentReads(w.percent)} of your ${w.key === 'session' ? 'session' : 'weekly'} limit`);
  return spent.length ? `You have used ${spent.join(' and ')}.` : null;
}

function ResetRow({
  reset,
  windows,
  now,
  confirming,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  reset: PlanReset;
  windows: PlanWindow[];
  now: Date;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const expires = expiryReads(reset.expiresAt);
  const until = untilReads(reset.expiresAt, now);
  const granted = expiryReads(reset.grantedAt);
  const refills = clearsReads(reset.clears);
  return (
    <Panel
      asChild
      tone="frame"
      inset="md"
      data-testid="usage-reset"
      data-reset={reset.id}
      data-usable={reset.usable}
    >
      <li>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{reset.title}</p>
            {reset.detail && <p className="mt-0.5 text-xs text-muted-foreground">{reset.detail}</p>}
            <p className="mt-1 text-[11px] text-muted-foreground" data-testid="usage-reset-expiry">
              {expires ? `Expires ${expires}${until ? ` · in ${until}` : ''}` : 'Does not expire'}
              {granted ? ` · Granted ${granted}` : ''}
              {reset.left !== null && reset.left > 1 ? ` · ${reset.left} uses left` : ''}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Refills your {refills}</p>
          </div>
          {!confirming && (
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              data-testid="usage-reset-use"
              disabled={!reset.usable || busy}
              onClick={onAsk}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Use reset
            </Button>
          )}
        </div>
        {confirming && (
          <Panel
            tone="attention"
            inset="md"
            className="mt-3"
            role="alertdialog"
            aria-labelledby={`reset-ask-${reset.id}`}
            data-testid="usage-reset-confirmation"
          >
            <p id={`reset-ask-${reset.id}`} className="text-sm font-medium text-foreground">
              Use this reset now?
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              It refills your {refills} straight away and cannot be undone.
              {spentReads(reset, windows) ? ` ${spentReads(reset, windows)}` : ''}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button size="xs" variant="ghost" data-testid="usage-reset-cancel" disabled={busy} onClick={onCancel}>
                Keep it
              </Button>
              <Button
                size="xs"
                variant="primary"
                data-testid="usage-reset-confirm"
                disabled={busy}
                autoFocus
                onClick={onConfirm}
              >
                {busy ? 'Using reset…' : 'Yes, use reset'}
              </Button>
            </div>
          </Panel>
        )}
      </li>
    </Panel>
  );
}

const SAID_TONE: Record<ResetOutcome['outcome'], 'success' | 'info' | 'danger'> = {
  reset: 'success',
  nothing_to_reset: 'info',
  no_reset: 'info',
  already_used: 'info',
  cooldown: 'info',
  unavailable: 'danger',
  unconfirmed: 'danger',
};

/**
 * The account's usage resets, each with when it expires, and a way to use one.
 *
 * Using one is the only thing in this panel that cannot be taken back, so the
 * button only asks. The reset is used only after a second, explicit yes.
 */
export function Resets({
  resets,
  windows,
  brand,
  profile,
  now,
}: {
  resets: PlanResets;
  windows: PlanWindow[];
  brand: Brand;
  profile?: string | null;
  now: Date;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ResetOutcome | null>(null);
  // One id per attempt the reader confirmed, kept when the answer was
  // unconfirmed, so trying again cannot use a second reset for the same yes.
  const attempt = useRef<{ reset: string; id: string } | null>(null);

  async function use(reset: PlanReset) {
    if (attempt.current?.reset !== reset.id) attempt.current = { reset: reset.id, id: crypto.randomUUID() };
    setBusy(true);
    setSaid(null);
    try {
      const res = await request('/api/workbench/usage/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brand, profile: profile ?? null, id: reset.id, attempt: attempt.current.id }),
        deadlineMs: 45_000,
      });
      const outcome = res.ok
        ? ((await res.json()) as ResetOutcome)
        : { outcome: 'unavailable' as const, message: 'Could not reset your limits. Nothing was used.' };
      setSaid(outcome);
      if (outcome.outcome !== 'unconfirmed') attempt.current = null;
    } catch {
      setSaid({
        outcome: 'unconfirmed',
        message: 'Could not confirm the reset. Check your usage in a moment before trying again.',
      });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  const unlisted = resets.available - resets.items.reduce((sum, r) => sum + (r.left ?? 1), 0);
  return (
    <Panel inset="md" data-testid="usage-resets" data-available={resets.available}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">Usage resets</h3>
        <span className="ml-auto text-xs text-muted-foreground" data-testid="usage-resets-count">
          {resets.available === 0 ? 'None available' : `${resets.available} available`}
        </span>
      </div>
      {resets.blocked && <p className="mt-1 text-xs text-muted-foreground">{resets.blocked}</p>}
      {resets.items.length > 0 && (
        <ul className="mt-2 space-y-2">
          {resets.items.map((reset) => (
            <ResetRow
              key={reset.id}
              reset={reset}
              windows={windows}
              now={now}
              confirming={confirming === reset.id}
              busy={busy}
              onAsk={() => {
                setSaid(null);
                setConfirming(reset.id);
              }}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void use(reset)}
            />
          ))}
        </ul>
      )}
      {unlisted > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {unlisted} more {unlisted === 1 ? 'reset is' : 'resets are'} not listed by the provider.
        </p>
      )}
      {said && (
        <Panel
          tone={SAID_TONE[said.outcome]}
          inset="sm"
          className="mt-2 text-xs text-foreground"
          role="status"
          data-testid="usage-reset-outcome"
          data-outcome={said.outcome}
        >
          {said.message}
        </Panel>
      )}
    </Panel>
  );
}

export function UsageView({ brand = 'claude', profile, onClose }: { brand?: Brand; profile?: string | null; onClose: () => void }) {
  const usage = usePlanUsage(brand, profile);
  const now = new Date();
  const windows = [usage.session, usage.week, ...usage.perModel].filter((w): w is PlanWindow => w !== null);

  return (
    <Overlay testId="usage-view" label="Plan usage" onClose={onClose}>
      {/* Capped and scrolled inside, as the token panel is: an uncapped box
          runs off the bottom of the window the moment the account has enough
          models to list (bw-3ug7.14). */}
      <div
        className={cn(overlayPanel, 'max-w-3xl')}
        data-available={usage.available}
      >
        <div className="flex items-center gap-2 border-b border-border/60 p-4">
          <h2 className="text-base font-semibold text-foreground">Plan usage</h2>
          {usage.plan && (
            <Badge variant="secondary" appearance="light" size="sm" data-testid="usage-plan">
              {usage.plan}
            </Badge>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            data-testid="usage-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="usage-scroll">
        {windows.length > 0 ? (
          <Panel inset="md" className="space-y-3">
            {windows.map((w) => (
              <Window key={w.key} window={w} now={now} />
            ))}
          </Panel>
        ) : (
          <Panel inset="md" className="text-sm text-muted-foreground">
            Plan usage unavailable
          </Panel>
        )}

        {usage.credits && (
          <Panel inset="md" className="text-sm" data-testid="usage-credits" data-enabled={usage.credits.enabled}>
            <h3 className="text-sm font-semibold text-foreground">Overage</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {usage.credits.enabled
                ? `${usage.credits.percent === null ? 'Available' : `${percentReads(usage.credits.percent)} used`}${
                    usage.credits.limit !== null
                      ? ` · ${usage.credits.currency ?? ''}${usage.credits.used ?? 0} of ${usage.credits.currency ?? ''}${usage.credits.limit}`
                      : ''
                  }`
                : 'Off'}
            </p>
          </Panel>
        )}

        {usage.resets && (
          <Resets resets={usage.resets} windows={windows} brand={brand} profile={profile} now={now} />
        )}

        {usage.driving.map((d) => (
          <Spending key={d.span} driving={d} />
        ))}

        </div>
      </div>
    </Overlay>
  );
}

/**
 * The two figures themselves, so the top line holds one component and not six.
 *
 * Both of them, not just the five-hour one: the week is what a run of long days
 * actually hits first, and a figure only a mouse-hover reveals is a figure the
 * reader does not have (bw-malh.5). They are separate chips rather than one
 * string because each carries its OWN colour — a calm session beside a week at
 * 96% is exactly the case a single colour hides.
 *
 * Each is a real Button inside the badge, which is the pattern the report
 * chip already uses: a Badge renders a <span>, and a click handler on a span is
 * reachable by mouse and by nothing else — no tab stop, no Enter, and nothing
 * for a screen reader to announce or press. This chip is the only way into the
 * usage picture in the whole app, so mouse-only would be the only way in
 * (bw-malh.7). The label it announces is the whole sentence, because "wk 22%"
 * read aloud is not a sentence.
 *
 * Draws nothing at all when there is no plan behind the account: a chip
 * reading "—%" beside the cost would be a limit the reader does not have.
 */
export function PlanChip({ usage, onOpen }: { usage: PlanUsage; onOpen: () => void }) {
  const five = usage.session;
  const week = usage.week;
  if (!usage.available || (!five && !week)) return null;
  const now = new Date();
  const title = [
    five ? `This session: ${windowReads(five, now)}` : null,
    week ? `This week: ${windowReads(week, now)}` : null,
    'View plan usage',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={cn('flex items-center', CHIP_GAP)} data-testid="plan-chips">
      {five && (
        <Tooltip label={title}>
          <Badge variant={severityVariant(five.severity)} appearance="light" size="sm" className="font-mono">
            <Button
              type="button"
              variant="foreground"
              size="inherit"
              className="p-0"
              data-testid="plan-chip"
              data-percent={five.percent ?? ''}
              data-severity={five.severity}
              aria-label={`Session usage: ${windowReads(five, now)}`}
              onClick={onOpen}
            >
              {sessionChipReads(five)}
            </Button>
          </Badge>
        </Tooltip>
      )}
      {week && (
        <Tooltip label={title}>
          <Badge variant={severityVariant(week.severity)} appearance="light" size="sm" className="font-mono">
            <Button
              type="button"
              variant="foreground"
              size="inherit"
              className="p-0"
              data-testid="plan-chip-week"
              data-percent={week.percent ?? ''}
              data-severity={week.severity}
              aria-label={`Weekly usage: ${windowReads(week, now)}`}
              onClick={onOpen}
            >
              {weekChipReads(week)}
            </Button>
          </Badge>
        </Tooltip>
      )}
    </span>
  );
}
