/**
 * The block shelf's single dispatch point. Every part of the document that
 * renders a `Block[]` goes through `renderBlock`, never a component import —
 * that keeps the mapping from `kind` to component in one place, matching
 * `blocks.py`'s own `KIND_TO_FN` table on the Python side.
 *
 * An unrecognised `kind` is a version skew between the server and this build,
 * not a bug to crash on — it renders a plain refusal so the rest of the
 * report still reads.
 */
import { Panel } from '@/components/ui/panel';

import type { Block, BlockKind } from '../types';
import { BarsBlockView } from './bars-block';
import { BreakdownBlockView } from './breakdown-block';
import { CompareBlockView } from './compare-block';
import { ImagesBlockView } from './images-block';
import { ListBlockView } from './list-block';
import { NoteBlockView } from './note-block';
import { RowsBlockView } from './rows-block';
import { TableBlockView } from './table-block';
import { TextBlockView } from './text-block';
import { TilesBlockView } from './tiles-block';
import { TrendBlockView } from './trend-block';
import { WipeBlockView } from './wipe-block';

type BlockComponent<B extends Block> = (props: { block: B }) => JSX.Element;

/* eslint-disable @typescript-eslint/no-explicit-any -- the map has to erase each branch's exact block type to line up with the union below */
const BLOCK_VIEWS: Record<BlockKind, BlockComponent<any>> = {
  text: TextBlockView,
  list: ListBlockView,
  rows: RowsBlockView,
  note: NoteBlockView,
  table: TableBlockView,
  tiles: TilesBlockView,
  bars: BarsBlockView,
  breakdown: BreakdownBlockView,
  trend: TrendBlockView,
  images: ImagesBlockView,
  compare: CompareBlockView,
  wipe: WipeBlockView,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function UnknownBlock({ kind }: { kind: string }) {
  return (
    <Panel role="alert" className="border-dashed text-sm text-t-muted">
      Can’t show this part of the report — unknown block kind “{kind}”.
    </Panel>
  );
}

export function renderBlock(block: Block, key?: string | number) {
  const View = BLOCK_VIEWS[block.kind as BlockKind];
  if (!View) return <UnknownBlock key={key} kind={String((block as { kind: unknown }).kind)} />;
  return <View key={key} block={block} />;
}

export function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <div className="grid gap-4">
      {blocks.map((block, i) => (
        <div key={i}>{renderBlock(block)}</div>
      ))}
    </div>
  );
}
