/**
 * A stack of key rows — a count or short tag, a title, an optional note.
 * `tone: "hot"` marks the row worth a second look (the reference tints it
 * teal, which this app has no token for — see `tone.ts` — so it reuses the
 * `teal` entry there, which itself reuses `info`). `tone: "gone"` marks a row
 * that no longer applies: struck through and dimmed, not removed, because a
 * report is a record of what was true, not a list that quietly forgets.
 */
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { TONE_CLASSES } from '../tone';
import type { RowsBlock } from '../types';

export function RowsBlockView({ block }: { block: RowsBlock }) {
  return (
    <div className="grid gap-1.5">
      {block.rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            'grid grid-cols-[auto_1fr] items-center gap-3 rounded-md bg-surface-overlay px-3.5 py-2.5',
            row.tone === 'hot' && TONE_CLASSES.teal.soft,
            row.tone === 'gone' && 'opacity-60',
          )}
        >
          <span
            className={cn(
              'text-right font-mono text-xs text-t-muted',
              row.tone === 'hot' && TONE_CLASSES.teal.text,
            )}
          >
            {row.n ?? ''}
          </span>
          <span>
            <b className={cn('font-semibold text-t-primary', row.tone === 'gone' && 'text-t-muted line-through')}>
              <Gloss text={row.title} />
            </b>
            {row.note && (
              <span className="block text-xs text-t-muted">
                <Gloss text={row.note} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
