/** One short sentence — the shelf's plainest block. `blocks.py` refuses anything longer than a sentence; this just draws whatever it is handed. */
import { Gloss } from '../glossary';
import type { TextBlock } from '../types';

export function TextBlockView({ block }: { block: TextBlock }) {
  return (
    <p className="text-base text-t-primary">
      <Gloss text={block.text} />
    </p>
  );
}
