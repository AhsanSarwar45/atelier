/**
 * A selection of a grid's cells, and the `@grid:` id it is written as
 * (docs/grids.md, "Work on cells").
 *
 * A selection is always a set of rows times a set of columns, which is what
 * `@grid:SLUG.ROWS.COLS` encodes: `ROWS` and `COLS` are each `*` or ids joined
 * by `+`. `@grid:camera.*.gpu` is a column, `@grid:camera.glare.*` a row and
 * `@grid:camera.glare+sunstar.gpu+perf` a block.
 */
import { cellLook, type GridCell, type GridColumn, type GridRow } from '@/workbench/grids/types';

/** A grid id, a row id, a column id: what a reference, a URL and a CLI argument hold unquoted. */
export const GRID_ID = '[a-z0-9][a-z0-9_-]{0,63}';
const ID = new RegExp(`^${GRID_ID}$`);
const PART = new RegExp(`^(?:\\*|${GRID_ID}(?:\\+${GRID_ID})*)$`);

export const isGridId = (id: string): boolean => ID.test(id);

/** All of them, or these. */
export type Chosen = '*' | string[];

/**
 * Rows times columns; with `onlyGaps`, only the gaps among them (All gaps
 * is every row and column with `onlyGaps`).
 */
export interface Selection { rows: Chosen; cols: Chosen; onlyGaps?: boolean }

/** Every gap in the grid. */
export const ALL_GAPS: Selection = { rows: '*', cols: '*', onlyGaps: true };

export interface GridRef { slug: string; selection: Selection | null }

const partOf = (pick: Chosen): string => (pick === '*' ? '*' : pick.join('+'));
const readPart = (part: string): Chosen => (part === '*' ? '*' : part.split('+'));

/** The id after `@grid:` for a grid, or for a selection of its cells. */
export function gridId(slug: string, selection?: Selection | null): string {
  if (!selection) return slug;
  return `${slug}.${partOf(selection.rows)}.${partOf(selection.cols)}`;
}

/** The id after `@grid:` read back, or null when it is not one. */
export function parseGridId(id: string): GridRef | null {
  const parts = id.split('.');
  if (parts.length === 1) return ID.test(parts[0]!) ? { slug: parts[0]!, selection: null } : null;
  if (parts.length !== 3) return null;
  const [slug, rows, cols] = parts as [string, string, string];
  if (!ID.test(slug) || !PART.test(rows) || !PART.test(cols)) return null;
  return { slug, selection: { rows: readPart(rows), cols: readPart(cols) } };
}

/** What New task writes into the composer for a selection. */
export function newTaskLine(slug: string, selection: Selection): string {
  return `@task @grid:${gridId(slug, selection)} `;
}

/** Whether a row or a column is in a pick. */
export const picks = (pick: Chosen, id: string): boolean => pick === '*' || pick.includes(id);

/** Whether a cell is in a selection. */
export const selects = (selection: Selection | null, row: string, col: string): boolean =>
  !!selection && picks(selection.rows, row) && picks(selection.cols, col);

/**
 * The rectangle between two cells, in the order the rows and columns are
 * drawn. A side that spans everything drawn is written `*`.
 */
export function rectangle(
  from: { row: string; col: string },
  to: { row: string; col: string },
  rowOrder: string[],
  colOrder: string[],
): Selection {
  const span = (order: string[], a: string, b: string): Chosen => {
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    if (i < 0 || j < 0) return [b];
    const ids = order.slice(Math.min(i, j), Math.max(i, j) + 1);
    return ids.length === order.length && order.length > 1 ? '*' : ids;
  };
  return { rows: span(rowOrder, from.row, to.row), cols: span(colOrder, from.col, to.col) };
}

/**
 * Why a cell cannot be claimed by a new task, or null when it can
 * (docs/grids.md, "Cell states": unchecked, gap and stale proved can be).
 */
export function blocker(cell: GridCell | undefined, row: GridRow | undefined, column: GridColumn | undefined): string | null {
  if (!row || !column) return 'Not in this grid';
  if (row.kind === 'reference' || cell?.ref) return row.ref ? `Read-only: owned by the ${row.ref.grid} grid` : 'Read-only';
  if (row.removed) return 'Row removed';
  if (row.missing) return 'Row missing';
  if (column.retired) return 'Column retired';
  if (!cell) return 'No cell';
  if (cell.claimedTask !== null && cell.claimedTask !== undefined) return `Claimed by #${cell.claimedTask}`;
  const look = cellLook(cell);
  if (look === 'proved') return 'Proved';
  if (look === 'na') return 'N/A';
  if (look === 'na_pending') return 'N/A pending';
  if (look === 'in_progress') return 'In progress';
  return null;
}

export interface SelectedCell { row: GridRow; column: GridColumn; cell: GridCell | undefined; blocker: string | null }

/** Every cell of a selection among the rows and columns drawn, with why it cannot be claimed. */
export function selectedCells(selection: Selection, rows: GridRow[], columns: GridColumn[], cells: GridCell[]): SelectedCell[] {
  const at = new Map(cells.map((cell) => [`${cell.row}\u0000${cell.col}`, cell]));
  const out: SelectedCell[] = [];
  for (const row of rows) {
    if (!picks(selection.rows, row.id)) continue;
    // A reference row has no cells of its own unless the owner grid's were read in.
    for (const column of columns) {
      if (!picks(selection.cols, column.id)) continue;
      const cell = at.get(`${row.id}\u0000${column.id}`);
      if (row.kind === 'reference' && !cell) continue;
      if (selection.onlyGaps && (!cell || cellLook(cell) !== 'gap')) continue;
      out.push({ row, column, cell, blocker: blocker(cell, row, column) });
    }
  }
  return out;
}
