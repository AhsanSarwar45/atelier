/**
 * "Next" — the plan if nothing changes, plus what happens if the manager
 * says nothing at all (`build.py`'s `next_card`). Cost is a coarse pill —
 * tiny/small/medium/large map onto the same tone ladder as everywhere else
 * in the report (green through red), not a literal duration.
 */
import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import { TONE_CLASSES } from '../tone';
import type { Cost, NextSlot } from '../types';
import { cn } from '@/lib/utils';

const COST_TONE: Record<Cost, keyof typeof TONE_CLASSES> = {
  tiny: 'green',
  small: 'blue',
  medium: 'amber',
  large: 'red',
};

export function NextCard({ next, id }: { next: NextSlot; id?: string }) {
  return (
    <ReportCard id={id} kind="next" label="Next">
      <div className={cn('grid grid-cols-1 gap-1 rounded-md bg-surface-overlay px-3.5 py-3 text-sm')}>
        <b className="text-[11px] font-bold uppercase tracking-wide text-t-muted">If you say nothing</b>
        <span className="text-t-primary">
          <Gloss text={next.if_nothing} />
        </span>
      </div>
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface-overlay">
              <th className="whitespace-nowrap px-3.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-t-muted">
                #
              </th>
              <th className="whitespace-nowrap px-3.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-t-muted">
                Step
              </th>
              <th className="whitespace-nowrap px-3.5 py-2.5 text-right text-[11px] font-bold uppercase tracking-wide text-t-muted">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {next.steps.map((s, i) => {
              const tone = TONE_CLASSES[COST_TONE[s.cost]];
              return (
                <tr key={i} className="border-b border-b-subtle last:border-b-0">
                  <td className="px-3.5 py-3 align-middle text-t-muted">{i + 1}</td>
                  <td className="px-3.5 py-3 align-middle text-t-primary [overflow-wrap:anywhere]">
                    <Gloss text={s.step} />
                    {s.starting && (
                      <span
                        className={cn(
                          'ml-2 rounded px-1.5 py-0.5 text-[11px] font-bold',
                          TONE_CLASSES.green.soft,
                          TONE_CLASSES.green.text,
                        )}
                      >
                        starting here
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-3 text-right align-middle">
                    <span className={cn('rounded px-2 py-0.5 text-xs font-bold', tone.soft, tone.text)}>
                      {s.cost}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ReportCard>
  );
}
