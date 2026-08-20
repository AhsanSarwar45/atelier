/**
 * The whole usage picture, behind the chip on the chat's top line.
 *
 * The chip answers one question — how much of the five-hour window is gone —
 * because that is the one that decides whether to start another agent in the
 * next minute. Everything else a reader eventually wants (the week, the model
 * the week is scoped to, credits, and what the spending is going ON) lives
 * here, one click away, rather than crowding a line that also has to carry the
 * agent, the folder and the cards (bw-malh).
 *
 * The figure is the ACCOUNT'S, so it is fetched once for the whole browser and
 * shared: ten chats open show one number and ask for it once a minute between
 * them, not ten times.
 */
'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/lib/api-base';
import {
  chipReads,
  clockReads,
  NOTHING_KNOWN,
  percentReads,
  type Driving,
  type PlanUsage,
  type PlanWindow,
  type Severity,
  untilReads,
  windowReads,
} from '@/workbench/plan-usage';

/** How often the browser asks again. The sidecar's own answer is cached just under this. */
const EVERY_MS = 60_000;

/* ------------------------------------------------------------------ *
 * One reading, shared by every chat on screen.
 * ------------------------------------------------------------------ */

let held: PlanUsage = NOTHING_KNOWN;
const listeners = new Set<(u: PlanUsage) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  try {
    const res = await fetch(apiUrl('/api/workbench/usage'));
    if (!res.ok) return;
    held = (await res.json()) as PlanUsage;
    listeners.forEach((tell) => tell(held));
  } catch {
    // No answer means the last one stands. A plan window does not move fast
    // enough for a missed minute to mislead anyone, and blanking the chip on a
    // dropped request would make it flicker all day.
  }
}

/**
 * What the account has spent, kept fresh.
 *
 * Every caller shares one reading and one timer; the timer stops when the last
 * chat showing it goes away.
 */
export function usePlanUsage(): PlanUsage {
  const [usage, setUsage] = useState<PlanUsage>(held);
  useEffect(() => {
    listeners.add(setUsage);
    if (!timer) {
      void refresh();
      timer = setInterval(() => void refresh(), EVERY_MS);
    }
    return () => {
      listeners.delete(setUsage);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return usage;
}

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
    <div className="min-w-0">
      <h4 className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</h4>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.name} className="flex gap-2 text-xs">
            <span className="truncate text-foreground">{r.name}</span>
            <span className="ml-auto shrink-0 font-mono text-muted-foreground">{r.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Spending({ driving }: { driving: Driving }) {
  const span = driving.span === 'day' ? 'Last 24 hours' : 'Last 7 days';
  return (
    <div data-testid="usage-driving" data-span={driving.span} className="rounded-lg border border-border/60 p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">{span}</h3>
        <span className="ml-auto text-xs text-muted-foreground">
          {driving.requests.toLocaleString()} requests · {driving.sessions.toLocaleString()} sessions
        </span>
      </div>
      {driving.traits.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {driving.traits.map((t) => (
            <Badge key={t.key} variant="secondary" appearance="light" size="sm" data-testid="usage-trait" data-trait={t.key}>
              {t.label} {t.pct}%
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Names title="Agents" rows={driving.agents} />
        <Names title="Skills" rows={driving.skills} />
        <Names title="Plugins" rows={driving.plugins} />
        <Names title="Servers" rows={driving.servers} />
      </div>
    </div>
  );
}

export function UsageView({ onClose }: { onClose: () => void }) {
  const usage = usePlanUsage();
  const now = new Date();
  const windows = [usage.session, usage.week, ...usage.perModel].filter((w): w is PlanWindow => w !== null);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-8" data-testid="usage-view">
      <div
        className="w-full max-w-2xl space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background p-4 shadow-2xl"
        data-available={usage.available}
      >
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">Plan usage</h2>
          {usage.plan && (
            <Badge variant="secondary" appearance="light" size="sm" data-testid="usage-plan">
              {usage.plan}
            </Badge>
          )}
          <Button size="xs" variant="outline" className="ml-auto" data-testid="usage-close" onClick={onClose}>
            Close
          </Button>
        </div>

        {windows.length > 0 ? (
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            {windows.map((w) => (
              <Window key={w.key} window={w} now={now} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
            {/* An API key, Bedrock, Vertex — anywhere a claude.ai plan is not
                what pays. Saying so is the answer; a row of zeroes is not. */}
            No plan allowance to report: this machine is not billing a claude.ai plan, or the kit is too old to say.
          </p>
        )}

        {usage.credits && (
          <div className="rounded-lg border border-border/60 p-3 text-sm" data-testid="usage-credits" data-enabled={usage.credits.enabled}>
            <h3 className="text-sm font-semibold text-foreground">Extra usage credits</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {usage.credits.enabled
                ? `${percentReads(usage.credits.percent)} used${
                    usage.credits.limit !== null
                      ? ` · ${usage.credits.currency ?? ''}${usage.credits.used ?? 0} of ${usage.credits.currency ?? ''}${usage.credits.limit}`
                      : ''
                  }`
                : 'Off — work stops at the plan limit rather than spending past it.'}
            </p>
          </div>
        )}

        {usage.driving.map((d) => (
          <Spending key={d.span} driving={d} />
        ))}

        <p className="text-[11px] text-muted-foreground">
          This is the whole account’s allowance, not this chat’s: every chat on this machine spends it, and every
          chat shows the same figure. Read {clockReads(usage.at) ?? 'just now'}.
        </p>
      </div>
    </div>
  );
}

/**
 * The chip itself, so the top line holds one component and not six.
 *
 * Draws nothing at all when there is no plan behind the account: a chip
 * reading "—%" beside the cost would be a limit the reader does not have.
 */
export function PlanChip({ usage, onOpen }: { usage: PlanUsage; onOpen: () => void }) {
  const w = usage.session;
  if (!usage.available || !w) return null;
  const now = new Date();
  return (
    <Badge
      variant={severityVariant(w.severity)}
      appearance="light"
      size="sm"
      data-testid="plan-chip"
      data-percent={w.percent ?? ''}
      data-severity={w.severity}
      title={[windowReads(w, now), usage.week ? `This week: ${windowReads(usage.week, now)}` : null, 'Click for the whole picture']
        .filter(Boolean)
        .join('\n')}
      className="cursor-pointer font-mono"
      onClick={onOpen}
    >
      {chipReads(w)}
    </Badge>
  );
}
