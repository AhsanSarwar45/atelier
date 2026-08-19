/**
 * "Where we are" — Now/Next-up, a two-segment progress bar (done in green,
 * started-but-not-finished in amber, the remainder implicitly grey), and the
 * checklist itself. The bar is custom rather than the app's `Progress`
 * primitive because Radix's `Progress` only paints one indicator — this
 * needs two segments sharing a track (`build.py`'s `status_card`).
 */
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import { TONE_CLASSES } from '../tone';
import type { ChecklistState, ReportStatus, StatusItem } from '../types';

function pct(items: StatusItem[], state: ChecklistState): number {
  const n = Math.max(items.length, 1);
  return (items.filter((i) => i.state === state).length / n) * 100;
}

function CheckBox({ state }: { state: ChecklistState }) {
  if (state === 'done') {
    return (
      <span className="flex size-4 items-center justify-center rounded bg-success text-[11px] font-bold leading-none text-surface-base">
        ✓
      </span>
    );
  }
  if (state === 'draft') {
    return <span className="block size-4 rounded bg-warning" aria-hidden="true" />;
  }
  return <span className="block size-4 rounded border-[1.5px] border-b-strong" aria-hidden="true" />;
}

function ChecklistRow({ item }: { item: StatusItem }) {
  return (
    <li className="grid grid-cols-[20px_1fr] items-baseline gap-2.5">
      <CheckBox state={item.state} />
      <span className={cn(item.state === 'done' && 'text-t-muted')}>
        <Gloss text={item.text} />
        {item.tag && (
          <span
            className={cn(
              'ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-bold',
              TONE_CLASSES.amber.soft,
              TONE_CLASSES.amber.text,
            )}
          >
            {item.tag}
          </span>
        )}
      </span>
    </li>
  );
}

export function StatusCard({ status, id }: { status: ReportStatus; id?: string }) {
  const done = pct(status.items, 'done');
  const draft = pct(status.items, 'draft');

  return (
    <ReportCard id={id} kind="status" label="Where we are">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-surface-overlay px-3.5 py-3 text-sm">
          <b className="text-[11px] font-bold uppercase tracking-wide text-t-muted">Now</b>{' '}
          <span className="text-t-primary">{status.now}</span>
        </div>
        <div className="rounded-md bg-surface-overlay px-3.5 py-3 text-sm">
          <b className="text-[11px] font-bold uppercase tracking-wide text-t-muted">Next up</b>{' '}
          <span className="text-t-primary">{status.next_up}</span>
        </div>
      </div>

      <div className="grid gap-2.5">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-b-subtle" role="img" aria-label="Progress">
          <i className="block bg-success" style={{ width: `${done}%` }} />
          <u className="block bg-warning no-underline" style={{ width: `${draft}%` }} />
        </div>
        <div className="flex flex-wrap gap-3.5 text-xs text-t-muted">
          <span className="flex items-center gap-1.5">
            <b className="block size-2 rounded-sm bg-success" />
            Settled
          </span>
          <span className="flex items-center gap-1.5">
            <b className="block size-2 rounded-sm bg-warning" />
            Started, not finished
          </span>
          <span className="flex items-center gap-1.5">
            <b className="block size-2 rounded-sm bg-b-strong" />
            Not started
          </span>
        </div>
      </div>

      <ul className="grid gap-2.5">
        {status.items.map((item, i) => (
          <ChecklistRow key={i} item={item} />
        ))}
      </ul>
    </ReportCard>
  );
}
