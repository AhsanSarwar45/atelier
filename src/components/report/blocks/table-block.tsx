/**
 * A table. Columns may be plain strings or `{name, align}`; cells may be
 * plain text/numbers or one of three typed shapes — a coloured pill, a
 * monospaced number, or bold text (`blocks.py`'s `_cell`). Wide tables scroll
 * inside their own strip rather than widening the reading column.
 */
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { TONE_CLASSES } from '../tone';
import type { TableBlock, TableCell, TableColumn } from '../types';

function columnName(c: TableColumn): string {
  return typeof c === 'string' ? c : c.name;
}

function columnAlign(c: TableColumn): 'text' | 'right' | 'num' {
  return typeof c === 'string' ? 'text' : (c.align ?? 'text');
}

function CellView({ cell }: { cell: TableCell }) {
  if (cell !== null && typeof cell === 'object') {
    if ('pill' in cell) {
      const tone = TONE_CLASSES[cell.tone ?? 'grey'];
      return (
        <span className={cn('rounded px-2 py-0.5 text-xs font-bold', tone.soft, tone.text)}>
          <Gloss text={String(cell.pill)} />
        </span>
      );
    }
    if ('num' in cell) return <>{String(cell.num)}</>;
    if ('bold' in cell)
      return (
        <b className="font-semibold text-t-primary">
          <Gloss text={String(cell.bold)} />
        </b>
      );
  }
  return <Gloss text={String(cell)} />;
}

export function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="bg-surface-overlay">
            {block.columns.map((col, i) => (
              <th
                key={i}
                className={cn(
                  'whitespace-nowrap px-3.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-t-muted',
                  columnAlign(col) !== 'text' && 'text-right',
                )}
              >
                {columnName(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i} className="border-b border-b-subtle last:border-b-0">
              {row.map((cell, j) => {
                const align = columnAlign(block.columns[j]);
                return (
                  <td
                    key={j}
                    className={cn(
                      'px-3.5 py-3 align-middle',
                      align === 'num' && 'text-right font-mono tabular-nums text-t-secondary',
                      align === 'right' && 'text-right',
                    )}
                  >
                    <CellView cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
