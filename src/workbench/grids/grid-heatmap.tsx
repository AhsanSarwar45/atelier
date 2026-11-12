'use client';

/**
 * A grid as a heatmap (docs/grids.md, "Grid view"): rows down the side,
 * columns along the top, one square per cell coloured by its state.
 *
 * Clicking a column header selects the column, a row header the row; a row
 * or column one task claims whole carries a link to that task. Clicking
 * a cell opens its detail, and ctrl- or cmd-click selects it instead.
 * Shift-click, or a drag with the mouse, selects the rectangle from the cell
 * clicked first. Cells grow with the width, between CELL_MIN and CELL_MAX, the
 * same on a phone as on a desktop; column names read upwards and wrap rather
 * than being cut. When the table is wider than the page it scrolls sideways
 * under row names that stay put.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

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

/** The smallest and largest a cell is drawn, the same on a phone and a desktop. */
export const CELL_MIN = 32;
export const CELL_MAX = 48;
/** The gap between cells. */
const GAP = 3;
/** A column name's line height, and the tallest the names' header grows. */
const LINE = 14;
const LABEL_MAX = 200;
/** What one character of a 12px name takes, near enough to size the header by. */
const CHAR_PX = 6.6;

/**
 * The cell size that fills `width` with `columns` columns beside the row
 * names, kept between CELL_MIN and CELL_MAX.
 */
export function cellSize(width: number, names: number, columns: number): number {
  if (!columns || width <= 0) return CELL_MIN;
  const each = Math.floor((width - names) / columns) - GAP;
  return Math.max(CELL_MIN, Math.min(CELL_MAX, each));
}

/**
 * How tall the column names' header is: the names read upwards and wrap to as
 * many lines as fit across a column (two at the smallest size, three at the
 * largest), so the longest name is shown whole rather than cut.
 */
export function headerHeight(names: string[], size: number): number {
  const longest = Math.max(0, ...names.map((name) => name.length)) * CHAR_PX;
  const lines = Math.max(1, Math.floor((size - 4) / LINE));
  // A little over an even share, since lines break between words.
  return Math.ceil(Math.min(longest, Math.max(96, longest / lines + 4 * CHAR_PX), LABEL_MAX)) + 8;
}

/**
 * The task claiming every one of these cells, or null when they are not all
 * claimed by one task (or there are none).
 */
export function sharedClaim(cells: Array<GridCell | undefined>): number | null {
  let task: number | null = null;
  for (const cell of cells) {
    if (!cell || cell.claimedTask === null || cell.claimedTask === undefined) return null;
    if (task !== null && cell.claimedTask !== task) return null;
    task = cell.claimedTask;
  }
  return task;
}

/** A small link to the task that claims a whole row or column. */
function ClaimLink({ task, where, onOpenTask, className }: { task: number; where: string; onOpenTask?: (task: number) => void; className?: string }) {
  const look = 'rounded-sm px-1 font-mono text-[10px] leading-4 text-[var(--color-info-accent)]';
  if (!onOpenTask) return <span data-testid="grid-claim" data-task={task} className={cn(look, className)}>{`#${task}`}</span>;
  return (
    <Tooltip label={`${where} is claimed by task #${task}`}>
      <Button
        type="button"
        variant="ghost"
        size="none"
        data-testid="grid-claim"
        data-task={task}
        data-reach="own"
        aria-label={`Open task #${task}`}
        onClick={() => onOpenTask(task)}
        className={cn(look, 'hover:underline', className)}
      >
        {`#${task}`}
      </Button>
    </Tooltip>
  );
}

/** The width of the box, followed as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

export function GridHeatmap({ rows, columns, cells, selection, onSelect, onOpenCell, onOpenTask }: {
  rows: DrawnRow[];
  columns: GridColumn[];
  cells: GridCell[];
  /** What is outlined: a selection made on purpose, or the cell whose detail is open. */
  selection: Selection | null;
  /** A selection made on purpose: a row or column name, shift-click, ctrl-click or a drag. */
  onSelect: (selection: Selection) => void;
  /** A plain click on a cell: its detail. */
  onOpenCell: (row: GridRow, column: GridColumn) => void;
  /** Opens the task that claims a whole row or column. */
  onOpenTask?: (task: number) => void;
}) {
  const at = new Map(cells.map((cell) => [key(cell.row, cell.col), cell]));
  const rowOrder = rows.map((drawn) => drawn.row.id);
  const colOrder = columns.map((column) => column.id);
  const anchor = useRef<{ row: string; col: string } | null>(null);
  const drag = useRef<{ from: { row: string; col: string }; moved: boolean } | null>(null);
  const [box, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  // Row names take what they need, up to two fifths of the width (and 16rem), wrapping past it.
  const wanted = Math.max(64, ...rows.map(({ row, depth }) => row.name.length * CHAR_PX + depth * 12 + 20));
  const names = Math.round(Math.min(wanted, Math.max(width * 0.4, 112), 256));
  const size = cellSize(width, names, columns.length);
  const header = headerHeight(columns.map((column) => column.name), size);
  const whole = !!selection && !selection.onlyGaps;
  const colSelected = (id: string) => whole && selection!.cols !== '*' && selection!.cols.includes(id) && selection!.rows === '*';
  const rowSelected = (id: string) => whole && selection!.rows !== '*' && selection!.rows.includes(id) && selection!.cols === '*';
  // A row or column one task claims whole. A reference row's cells are the owner grid's.
  const own = rows.filter(({ row }) => row.kind !== 'reference');
  const rowClaim = new Map(own.map(({ row }) => [row.id, sharedClaim(columns.map((column) => at.get(key(row.id, column.id))))]));
  const colClaim = new Map(columns.map((column) => [column.id, own.length ? sharedClaim(own.map(({ row }) => at.get(key(row.id, column.id)))) : null]));
  const anyColClaim = [...colClaim.values()].some((task) => task !== null);

  return (
    <div ref={box} className="w-full shrink-0 overflow-x-auto overflow-y-hidden overscroll-x-contain" data-testid="grid-heatmap" data-cell-size={size}>
      <table className="border-separate select-none" style={{ borderSpacing: GAP }}>
        <thead>
          <tr>
            <th className="sticky left-0 z-20 bg-background" style={{ minWidth: names, maxWidth: names }} />
            {columns.map((column) => (
              <th key={column.id} scope="col" className="p-0 align-bottom" style={{ height: header, width: size, minWidth: size }}>
                <Tooltip label={column.proofRule ? `${column.name}: ${column.proofRule}` : column.name} side="top">
                  <Button
                    type="button"
                    variant="foreground"
                    size="none"
                    data-testid="grid-column"
                    data-col={column.id}
                    data-reach="own"
                    aria-pressed={colSelected(column.id)}
                    onClick={() => {
                      anchor.current = null;
                      onSelect({ rows: '*', cols: [column.id] });
                    }}
                    style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', width: size, maxHeight: header - 4, lineHeight: `${LINE}px` }}
                    className={cn(
                      'flex items-center justify-start overflow-hidden whitespace-normal break-words rounded-sm py-1 text-left text-xs font-normal text-muted-foreground hover:bg-accent hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      column.retired && 'line-through',
                      colSelected(column.id) && 'bg-accent font-medium text-foreground',
                    )}
                  >
                    {column.name}
                  </Button>
                </Tooltip>
              </th>
            ))}
          </tr>
          {anyColClaim && (
            <tr>
              <th className="sticky left-0 z-20 bg-background" />
              {columns.map((column) => {
                const task = colClaim.get(column.id);
                return (
                  <th key={column.id} className="p-0 text-center font-normal" style={{ width: size }}>
                    {task != null && <ClaimLink task={task} where={`${column.name} column`} onOpenTask={onOpenTask} />}
                  </th>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map(({ row, depth }) => (
            <tr key={row.id} data-testid="grid-row" data-row={row.id} data-missing={row.missing || undefined} className={cn(row.missing && 'opacity-40')}>
              <th scope="row" className="sticky left-0 z-10 bg-background p-0 text-left font-normal" style={{ minWidth: names, maxWidth: names }}>
                <div className="flex items-center">
                <Tooltip label={row.missing ? 'Missing: the row search no longer lists it' : undefined} side="right">
                <Button
                  type="button"
                  variant="foreground"
                  size="none"
                  data-testid="grid-row-name"
                  data-reach="own"
                  aria-pressed={rowSelected(row.id)}
                  onClick={() => {
                    anchor.current = null;
                    onSelect({ rows: [row.id], cols: '*' });
                  }}
                  style={{ paddingLeft: `${0.25 + depth * 0.75}rem`, minHeight: size }}
                  className={cn(
                    'flex w-full min-w-0 flex-1 items-center justify-start gap-1 whitespace-normal rounded-sm py-0.5 pr-2 text-left text-xs font-normal leading-4 hover:bg-accent',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    rowSelected(row.id) && 'bg-accent font-medium',
                  )}
                >
                  <span className={cn('min-w-0 break-words', row.kind === 'reference' && 'italic text-muted-foreground')}>{row.name}</span>
                  {row.kind === 'reference' && row.ref && <span className="shrink-0 text-[10px] text-muted-foreground">{row.ref.grid}</span>}
                </Button>
                </Tooltip>
                {rowClaim.get(row.id) != null && <ClaimLink task={rowClaim.get(row.id)!} where={`${row.name} row`} onOpenTask={onOpenTask} className="mr-1 shrink-0" />}
                </div>
              </th>
              {columns.map((column) => {
                const cell = at.get(key(row.id, column.id));
                if (!cell) return <td key={column.id} className="p-0" />;
                const look = cellLook(cell);
                const chosen = selects(selection, row.id, column.id) && (!selection?.onlyGaps || look === 'gap');
                const here = { row: row.id, col: column.id };
                return (
                  <td key={column.id} className="p-0 align-middle">
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
                      data-reach="own"
                      aria-pressed={chosen}
                      aria-label={`${row.name} × ${column.name}: ${LOOK_LABEL[look]}${cell.claimedTask ? `, claimed by #${cell.claimedTask}` : ''}`}
                      onPointerDown={(event) => {
                        if (event.pointerType !== 'mouse' || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
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
                        // Ctrl- or Cmd-click picks the cell for a task without opening it.
                        if (event.ctrlKey || event.metaKey) {
                          onSelect({ rows: [row.id], cols: [column.id] });
                          return;
                        }
                        onOpenCell(row, column);
                      }}
                      style={{ ...(look === 'stale' ? HATCH : undefined), width: size, height: size }}
                      className={cn(
                        'flex items-center justify-center rounded-[4px] text-xs leading-none',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        LOOK_CLASS[look],
                        cell.ref && 'opacity-70',
                        chosen && 'relative z-[1] ring-2 ring-foreground ring-offset-1 ring-offset-background',
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
