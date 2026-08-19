/** A row of big numbers — a value, its key, and an optional coloured delta. */
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { TONE_CLASSES } from '../tone';
import type { TilesBlock } from '../types';

export function TilesBlockView({ block }: { block: TilesBlock }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2.5">
      {block.tiles.map((tile, i) => {
        const tone = TONE_CLASSES[tile.tone ?? 'grey'];
        return (
          <div key={i} className="rounded-md bg-surface-overlay px-4 py-3.5">
            <div className="font-mono text-2xl font-bold leading-tight tracking-tight text-t-primary">
              {tile.value}
            </div>
            <div className="mt-1.5 text-[11px] font-bold uppercase tracking-wide text-t-muted">
              <Gloss text={tile.key} />
            </div>
            {tile.delta && <div className={cn('mt-1 text-xs font-semibold', tone.text)}>{tile.delta}</div>}
          </div>
        );
      })}
    </div>
  );
}
