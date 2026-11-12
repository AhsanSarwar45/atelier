'use client';

/**
 * A grid as a heatmap (docs/grids.md, "Grid view"): rows down the side,
 * columns along the top, one square per cell coloured by its state.
 *
 * Clicking a column header selects the column, a row header the row, and a
 * cell the cell, which also opens its detail. Shift-click, or a drag with the
 * mouse, selects the rectangle from the cell clicked first. On a phone the
 * table scrolls sideways under row names that stay put.
 */
import { useEffect, useRef, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { rectangle, selects, type Selection } from '@/workbench/grids/selection';
import { cellLook, LOOK_LABEL, type CellLook, type GridCell, type GridColumn, type GridRow } from '@/workbench/grids/types';

/** A row as drawn: a combination sits indented under the first row it combines. */
export interface DrawnRow { row: GridRow; depth: number }

/**
 * The rows in the order they are drawn: the grid's own order, with each
 * combination moved under the first row in its `of`. Removed rows are left
 * out; missing ones stay, dimmed.
 */
export function orderRows(rows: GridRow[]): DrawnRow[] {
  const live = rows.filter((row) => !row.removed);
  const ids = new Set(live.map((row) => row.id));
  const under = new Map<string, GridRow[]>();
  const top: GridRow[] = [];
  for (const row of live) {
    const first = row.kind === 'combination' ? row.of?.[0] : undefined;
    if (first && first !== row.id && ids.has(first)) under.set(first, [...(under.get(first) ?? []), row]);
    else top.push(row);
  }
  const out: DrawnRow[] = [];
  const placed = new Set<string>();
  const place = (row: GridRow, depth: number) => {
    if (placed.has(row.id)) return;
    placed.add(row.id);
    out.push({ row, depth });
    for (const child of under.get(row.id) ?? []) place(child, depth + 1);
  };
  for (const row of top) place(row, row.kind === 'combination' ? 1 : 0);
  // A combination whose first row is itself under a loop is still drawn.
  for (const row of live) place(row, 1);
  return out;
}

const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, var(--color-success-accent) 0 2px, transparent 2px 5px)',
};

/** Each state's colour: muted, destructive, info, success, success hatched, a warning outline, a dash. */
export const LOOK_CLASS: Record<CellLook, string> = {
  unchecked: 'bg-muted',
  gap: 'bg-[var(--color-destructive-accent)]',
  in_progress: 'bg-[var(--color-info-accent)]',
  proved: 'bg-[var(--color-success-accent)]',
  stale: 'bg-[var(--color-success-soft)]',
  na_pending: 'border-2 border-[var(--color-warning-accent)] bg-transparent',
  na: 'border border-border/60 bg-transparent text-muted-foreground',
};

/** One cell's square, drawn the same in the heatmap, its legend and its detail. */
export function CellSquare({ look, className }: { look: CellLook; className?: string }) {
  return (
    <span
      aria-hidden
      data-look={look}
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] text-[10px] leading-none', LOOK_CLASS[look], className)}
      style={look === 'stale' ? HATCH : undefined}
    >
      {look === 'na' ? '–' : null}
    </span>
  );
}

/** What each colour means, under the heatmap. */
export function Legend({ className }: { className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground', className)} data-testid="grid-legend">
      {(Object.keys(LOOK_CLASS) as CellLook[]).map((look) => (
        <li key={look} className="inline-flex items-center gap-1.5"><CellSquare look={look} />{LOOK_LABEL[look]}</li>
      ))}
    </ul>
  );
}

const key = (row: string, col: string) => `${row}\u0000${col}`;

export function GridHeatmap({ rows, columns, cells, selection, onSelect, onOpenCell }: {
  rows: DrawnRow[];
  columns: GridColumn[];
  cells: GridCell[];
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  /** A plain click on a cell: its detail. */
  onOpenCell: (row: GridRow, column: GridColumn) => void;
}) {
  const at = new Map(cells.map((cell) => [key(cell.row, cell.col), cell]));
  const rowOrder = rows.map((drawn) => drawn.row.id);
  const colOrder = columns.map((column) => column.id);
  const anchor = useRef<{ row: string; col: string } | null>(null);
  const drag = useRef<{ from: { row: string; col: string }; moved: boolean } | null>(null);

  useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  return (
    <div className="min-h-0 overflow-auto overscroll-x-contain" data-testid="grid-heatmap">
      <table className="border-separate border-spacing-[3px] select-none">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-30 bg-background" />
            {columns.map((column) => (
              <th key={column.id} scope="col" className="sticky top-0 z-20 bg-background p-0 align-bottom">
                <Tooltip label={column.proofRule || undefined} side="bottom">
                  <Button
                    type="button"
                    variant="foreground"
                    size="none"
                    data-testid="grid-column"
                    data-col={column.id}
                    aria-pressed={!!selection && selection.rows === '*' && selection.cols !== '*' && selection.cols.length === 1 && selection.cols[0] === column.id}
                    onClick={() => {
                      anchor.current = null;
                      onSelect({ rows: '*', cols: [column.id] });
                    }}
                    className={cn(
                      'mx-auto block max-h-36 w-8 truncate rounded-sm px-1 py-1 text-left text-xs font-normal text-muted-foreground [writing-mode:vertical-rl] rotate-180 hover:bg-accent hover:text-foreground sm:w-6',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      column.retired && 'line-through',
                      selection && selection.cols !== '*' && selection.cols.includes(column.id) && 'font-medium text-foreground',
                    )}
                  >
                    {column.name}
                  </Button>
                </Tooltip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, depth }) => (
            <tr key={row.id} data-testid="grid-row" data-row={row.id} data-missing={row.missing || undefined} className={cn(row.missing && 'opacity-40')}>
              <th scope="row" className="sticky left-0 z-10 bg-background p-0 text-left font-normal">
                <Tooltip label={row.missing ? 'Missing: the row search no longer lists it' : undefined} side="right">
                <Button
                  type="button"
                  variant="foreground"
                  size="none"
                  data-testid="grid-row-name"
                  onClick={() => {
                    anchor.current = null;
                    onSelect({ rows: [row.id], cols: '*' });
                  }}
                  style={{ paddingLeft: `${0.25 + depth * 0.75}rem` }}
                  className={cn(
                    'flex h-8 w-36 items-center justify-start gap-1 rounded-sm pr-2 text-left text-xs font-normal hover:bg-accent sm:h-6 sm:w-56',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selection && selection.rows !== '*' && selection.rows.includes(row.id) && 'font-medium',
                  )}
                >
                  <span className={cn('min-w-0 truncate', row.kind === 'reference' && 'italic text-muted-foreground')}>{row.name}</span>
                  {row.kind === 'reference' && row.ref && <span className="shrink-0 text-[10px] text-muted-foreground">{row.ref.grid}</span>}
                </Button>
                </Tooltip>
              </th>
              {columns.map((column) => {
                const cell = at.get(key(row.id, column.id));
                if (!cell) return <td key={column.id} className="p-0" />;
                const look = cellLook(cell);
                const chosen = selects(selection, row.id, column.id);
                const here = { row: row.id, col: column.id };
                return (
                  <td key={column.id} className="p-0">
                    <Button
                      type="button"
                      variant="foreground"
                      size="none"
                      data-testid="grid-cell"
                      data-row={row.id}
                      data-col={column.id}
                      data-state={cell.state}
                      data-look={look}
                      data-ref={cell.ref ? 'yes' : undefined}
                      aria-pressed={chosen}
                      aria-label={`${row.name} × ${column.name}: ${LOOK_LABEL[look]}${cell.claimedTask ? `, claimed by #${cell.claimedTask}` : ''}`}
                      onPointerDown={(event) => {
                        if (event.pointerType !== 'mouse' || event.button !== 0 || event.shiftKey) return;
                        drag.current = { from: here, moved: false };
                      }}
                      onPointerEnter={(event) => {
                        const held = drag.current;
                        if (!held || !(event.buttons & 1)) return;
                        if (held.from.row === here.row && held.from.col === here.col && !held.moved) return;
                        held.moved = true;
                        anchor.current = held.from;
                        onSelect(rectangle(held.from, here, rowOrder, colOrder));
                      }}
                      onClick={(event) => {
                        if (event.shiftKey && anchor.current) {
                          onSelect(rectangle(anchor.current, here, rowOrder, colOrder));
                          return;
                        }
                        anchor.current = here;
                        onSelect({ rows: [row.id], cols: [column.id] });
                        onOpenCell(row, column);
                      }}
                      style={look === 'stale' ? HATCH : undefined}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-[4px] text-xs leading-none sm:size-6',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        LOOK_CLASS[look],
                        cell.ref && 'opacity-70',
                        chosen && 'outline outline-2 outline-offset-1 outline-primary',
                      )}
                    >
                      {look === 'na' ? '–' : null}
                    </Button>
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
