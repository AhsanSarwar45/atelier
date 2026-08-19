/**
 * "Decisions" — calls already made on the manager's behalf, listed so none
 * of them are a surprise. One that `needs_you` is flagged instead of
 * offered an override — it is already waiting on a reply, not something to
 * quietly veto. Every other decision gets an override button; pressing it
 * flags the row and appends "Change {ids}." to the composed reply, read by
 * the same `useReply` state the action card's chips write to
 * (`build.py`'s `decisions_card`, `page.js`'s `button.ovr` handler).
 */
'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import { useReply } from '../reply';
import { TONE_CLASSES } from '../tone';
import type { Decision } from '../types';

function DecisionRow({ decision }: { decision: Decision }) {
  const { isOverridden, toggleOverride } = useReply();
  const flagged = !decision.needs_you && isOverridden(decision.id);

  return (
    <div
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md px-3.5 py-2.5',
        decision.needs_you || flagged ? TONE_CLASSES.amber.soft : 'bg-surface-overlay',
      )}
    >
      <span className="font-mono text-xs text-t-muted">{decision.id}</span>
      <span className="grid gap-0.5">
        <span>
          <b className="font-semibold text-t-primary">
            <Gloss text={decision.title} />
          </b>
          {decision.needs_you && (
            <span
              className={cn(
                'ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold',
                TONE_CLASSES.amber.soft,
                TONE_CLASSES.amber.text,
              )}
            >
              needs you
            </span>
          )}
          {!decision.needs_you && decision.tag && (
            <span
              className={cn(
                'ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold',
                TONE_CLASSES.violet.soft,
                TONE_CLASSES.violet.text,
              )}
            >
              {decision.tag}
            </span>
          )}
        </span>
        {decision.why && (
          <span className="text-xs text-t-muted">
            <Gloss text={decision.why} />
          </span>
        )}
      </span>
      {!decision.needs_you && (
        <Button
          type="button"
          aria-pressed={flagged}
          variant="outline"
          size="xs"
          className={flagged ? cn(TONE_CLASSES.amber.text, TONE_CLASSES.amber.border) : undefined}
          onClick={() => toggleOverride(decision.id)}
        >
          {flagged ? 'change this' : 'override'}
        </Button>
      )}
    </div>
  );
}

export function DecisionsCard({ decisions }: { decisions: Decision[] }) {
  return (
    <ReportCard kind="decisions" label="Decisions · press override on any you want changed">
      <div className="grid gap-1.5">
        {decisions.map((d) => (
          <DecisionRow key={d.id} decision={d} />
        ))}
      </div>
    </ReportCard>
  );
}
