/** A callout box: a tone, an optional label above it, one sentence below. */
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { NOTE_CLASSES } from '../tone';
import type { NoteBlock } from '../types';

export function NoteBlockView({ block }: { block: NoteBlock }) {
  const tone = NOTE_CLASSES[block.tone ?? 'info'];
  return (
    <div className={cn('grid gap-1 rounded-md px-3.5 py-3 text-sm', tone.soft, tone.text)}>
      {block.label && <b className="text-[11px] font-bold uppercase tracking-wide">{block.label}</b>}
      <span>
        <Gloss text={block.text} />
      </span>
    </div>
  );
}
