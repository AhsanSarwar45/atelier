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
 * The figure is the ACCOUNT'S, so no screen here reads it: the sidecar keeps it
 * fresh on a beat of its own and pushes it to every open page, which is what
 * makes a chat sitting silent show the same number as the one being worked in
 * (live.ts `usePlanUsage`, bw-dmoe).
 */
'use client';

import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePlanUsage } from '@/workbench/live';
import {

  clockReads,
  percentReads,
  sessionChipReads,
  type Driving,
  type PlanUsage,
  type PlanWindow,
  type Severity,
  untilReads,
  weekChipReads,
  windowReads,
} from '@/workbench/plan-usage';

import { cn } from '@/lib/utils';

import { Overlay, overlayPanel } from './overlay';

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
    <Overlay testId="usage-view" onClose={onClose}>
      {/* Capped and scrolled inside, as the token panel is: an uncapped box
          runs off the bottom of the window the moment the account has enough
          models to list (bw-3ug7.14). */}
      <div
        className={cn(overlayPanel, 'max-w-2xl')}
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
 * Each is a real <button> inside the badge, which is the pattern the report
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
    'Click for the whole picture',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="flex items-center gap-1" data-testid="plan-chips">
      {five && (
        <Badge variant={severityVariant(five.severity)} appearance="light" size="sm" className="font-mono">
          <button
            type="button"
            data-testid="plan-chip"
            data-percent={five.percent ?? ''}
            data-severity={five.severity}
            title={title}
            aria-label={`Plan usage — this session: ${windowReads(five, now)}. Opens the whole usage picture.`}
            onClick={onOpen}
          >
            {sessionChipReads(five)}
          </button>
        </Badge>
      )}
      {week && (
        <Badge variant={severityVariant(week.severity)} appearance="light" size="sm" className="font-mono">
          <button
            type="button"
            data-testid="plan-chip-week"
            data-percent={week.percent ?? ''}
            data-severity={week.severity}
            title={title}
            aria-label={`Plan usage — this week: ${windowReads(week, now)}. Opens the whole usage picture.`}
            onClick={onOpen}
          >
            {weekChipReads(week)}
          </button>
        </Badge>
      )}
    </span>
  );
}
