/** A plain bulleted or numbered list. */
import { Gloss } from '../glossary';
import type { ListBlock } from '../types';

export function ListBlockView({ block }: { block: ListBlock }) {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag className={`grid grid-cols-1 gap-1.5 pl-5 text-sm text-t-secondary ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
      {block.items.map((item, i) => (
        <li key={i}>
          <Gloss text={item} />
        </li>
      ))}
    </Tag>
  );
}
