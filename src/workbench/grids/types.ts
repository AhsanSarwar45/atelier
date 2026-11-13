/**
 * Coverage grids as the server hands them over (docs/grids.md, "HTTP").
 *
 * Read loosely, like tasks: a field the server leaves out is drawn as missing
 * rather than taken as a broken grid. The draft a grid is waiting on
 * (`pending`) is the agent's payload as the server stored it, so it is read in
 * either spelling, `row_search` or `rowSearch`.
 */

import type { Note } from '@/workbench/notes';

export const CELL_STATES = ['unchecked', 'gap', 'in_progress', 'proved', 'na_pending', 'na'] as const;
export type CellState = (typeof CELL_STATES)[number];

export type GridStatus = 'draft' | 'approved' | 'discarded';

export interface RowSearch { command: string; watch: string[]; timeout_s?: number; timeoutS?: number }

export interface Discovery {
  at: number;
  head?: string | null;
  ok: boolean;
  added?: string[];
  missing?: string[];
  back?: string[];
  skipped?: Array<{ id: string; owner: string }>;
  error?: string | null;
}

export interface GridCounts {
  counted: number;
  proved: number;
  stale: number;
  gap: number;
  unchecked: number;
  inProgress: number;
  naPending: number;
  na: number;
}

export interface GridSummary {
  projectId: string;
  slug: string;
  title: string;
  area: string;
  status: GridStatus;
  template: string | null;
  rowSearch: RowSearch | null;
  createdBy?: string | null;
  approvedAt: number | null;
  updatedAt: number;
  /** A draft waiting for the owner: a new grid's content, or an edit to an approved one. */
  pending: Record<string, unknown> | null;
  discovery: Discovery | null;
  /** Proved and fresh over counted cells, rounded down. Null until approved. */
  percent: number | null;
  counts: GridCounts;
}

export interface TemplateColumn { id: string; name: string; proof_rule?: string; proofRule?: string }

export interface GridTemplate {
  name: string;
  columns: TemplateColumn[];
  /** A change waiting for the owner. */
  pending: Record<string, unknown> | null;
  updatedAt: number;
}

export interface GridColumn {
  id: string;
  name: string;
  proofRule: string;
  position: number;
  fromTemplate: boolean;
  retired: boolean;
  /** Check templates, `{row}` standing for the row id (docs/grids.md, "Column checks"). */
  checks?: Array<Record<string, unknown>>;
}

export type RowKind = 'feature' | 'combination' | 'reference';

export interface GridRow {
  id: string;
  name: string;
  kind: RowKind;
  paths: string[];
  of: string[] | null;
  ref: { grid: string; row: string } | null;
  source: 'search' | 'manual';
  missing: boolean;
  removed: boolean;
}

export interface LastCheckBrief { at: number; passed: boolean }

export interface CheckResult { name: string; exit: number; ms: number; tail?: string }

export interface LastCheck { at: number; head?: string | null; passed: boolean; results: CheckResult[] }

export interface GridCell {
  row: string;
  col: string;
  state: CellState;
  stale: boolean;
  claimedTask: number | null;
  reason: string | null;
  provedBy: string | null;
  provedAt: number | null;
  auditedAt: number | null;
  lastCheck: LastCheckBrief | null;
  proofSummary: string | null;
  /** The chat holding the claiming task, when the server says (absent on older servers). */
  claimedChat?: { id: string; title: string | null } | null;
  /** A reference row's cell: the owner grid's, read-only here. */
  ref?: boolean;
  /** The cell's resolved checks: its column's templates with `{row}` filled in, then its own. */
  checks?: Array<Record<string, unknown>>;
  /** Whether it has no checks at all, so it cannot be claimed or proved. */
  needsCheck?: boolean;
}

export interface GridDetail {
  grid: GridSummary;
  head: string | null;
  columns: GridColumn[];
  rows: GridRow[];
  cells: GridCell[];
}

export interface ProofCheck { name: string; command: string; timeout_s?: number }
export interface Benchmark { name: string; value: number; budget: number; unit: string; lower_is_better?: boolean }

export interface Proof {
  summary: string;
  checks: ProofCheck[];
  tests?: string[];
  commits?: string[];
  benchmarks?: Benchmark[];
  evidence?: string[];
}

/** One cell in full, as its detail panel reads it. */
export interface CellFull extends Omit<GridCell, 'lastCheck'> {
  proof: Proof | null;
  lastCheck: LastCheck | null;
  auditedBy?: string | null;
  claimedFrom?: string | null;
  /** Whether the proof's commits are in the base branch, when the server says. */
  merged?: boolean | null;
}

export interface GridEvent {
  seq: number;
  at: number;
  kind: string;
  row: string | null;
  col: string | null;
  sessionId: string | null;
  actor: 'agent' | 'owner' | string;
  payload: unknown;
}

export interface CellDetail {
  cell: CellFull;
  row: GridRow;
  column: GridColumn;
  events: GridEvent[];
  /** The cell's notes and its row's, column's and grid's, oldest first. */
  notes?: Note[];
}

export interface GridsList {
  projectId: string;
  grids: GridSummary[];
  templates: GridTemplate[];
}

export type GridOwnerAction =
  | 'approve' | 'discard' | 'approve_na' | 'reject_na' | 'reopen' | 'verify' | 'discover'
  | 'approve_template' | 'reject_template' | 'note';

export type GridWidgetEvent = 'draft' | 'template' | 'prove' | 'na' | 'audit' | 'reopen' | 'pass' | 'discover';

export interface AuditSummary {
  passed: number;
  reopened: number;
  cells?: Array<{ row: string; col: string; reason?: string | null }>;
}

/** What a pending template change does, as the server works it out. */
export interface TemplateChange {
  added: string[];
  removed: string[];
  changed: string[];
  /** The approved grids that use the template. */
  affects: string[];
  /** Grids whose own column already has an id the change adds. */
  clashes: Array<{ grid: string; column: string }>;
}

/** The `grid` chat widget, printed by every `atelier grid` change. */
export interface GridWidget {
  type: 'grid';
  title?: string;
  event: GridWidgetEvent | string;
  /** The grid the change is about. A template card has none. */
  grid?: GridSummary;
  cell?: Partial<CellFull> & { row: string; col: string };
  /** A template change: the template, and what approving it does. */
  template?: GridTemplate & { projectId?: string; change?: TemplateChange | null };
  audit?: AuditSummary;
}

/**
 * What `POST /api/workbench/grid` answers. `failed` is set when the action ran
 * but its checks failed: a re-check that reopened a cell, or, for a grid-wide
 * re-check, each cell that failed. A grid-wide re-check has no widget.
 */
export interface GridActionAnswer {
  grid?: GridSummary | null;
  cell?: CellFull | null;
  widget?: string | null;
  summary?: string;
  failed?: string | null;
  template?: (GridTemplate & { projectId?: string; change?: TemplateChange | null }) | null;
  audit?: AuditSummary | null;
}

export const STATE_LABEL: Record<CellState, string> = {
  unchecked: 'Unchecked',
  gap: 'Gap',
  in_progress: 'In progress',
  proved: 'Proved',
  na_pending: 'N/A pending',
  na: 'N/A',
};

/** What a cell is drawn as: its state, with a stale proof told apart. */
export type CellLook = CellState | 'stale';

export const cellLook = (cell: Pick<GridCell, 'state' | 'stale'>): CellLook =>
  cell.state === 'proved' && cell.stale ? 'stale' : cell.state;

export const LOOK_LABEL: Record<CellLook, string> = { ...STATE_LABEL, stale: 'Stale' };

/**
 * Whether a cell waits on a check before it can be worked on: it has none,
 * and it still needs work (unchecked, a gap, in progress, or a stale proof).
 * A fresh proof or an N/A needs nothing more.
 */
export function needsACheck(cell: Pick<GridCell, 'state' | 'stale' | 'needsCheck' | 'ref'> | undefined): boolean {
  if (!cell || cell.needsCheck !== true || cell.ref) return false;
  const look = cellLook(cell);
  return look === 'unchecked' || look === 'gap' || look === 'in_progress' || look === 'stale';
}

export const NEEDS_CHECK_LABEL = 'Needs a check';

/* ------------------------------------------------------------------ reading */

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** A column as a draft or a template writes it, in either spelling. */
export interface DraftColumn { id: string; name: string; proofRule: string; fromTemplate: boolean }
/** A row as a draft writes it. */
export interface DraftRow { id: string; name: string; kind: RowKind; of: string[]; ref: { grid: string; row: string } | null; source: string }

export function draftColumns(value: unknown): DraftColumn[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const c = rec(raw);
    return {
      id: str(c.id),
      name: str(c.name) || str(c.id),
      proofRule: str(c.proofRule) || str(c.proof_rule),
      fromTemplate: c.fromTemplate === true || c.from_template === true || c.from_template === 1,
    };
  }).filter((c) => c.id);
}

export function draftRows(value: unknown): DraftRow[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const r = rec(raw);
    const kind = r.kind === 'combination' || r.kind === 'reference' ? r.kind : 'feature';
    const ref = rec(r.ref);
    return {
      id: str(r.id),
      name: str(r.name) || str(r.id),
      kind,
      of: strings(r.of),
      ref: str(ref.grid) ? { grid: str(ref.grid), row: str(ref.row) } : null,
      source: str(r.source) || 'search',
    } as DraftRow;
  }).filter((r) => r.id);
}

/** What a pending draft holds, whichever way it was spelled. */
export interface DraftContent {
  title: string;
  area: string;
  template: string | null;
  command: string;
  watch: string[];
  columns: DraftColumn[];
  rows: DraftRow[];
}

export function draftContent(pending: unknown, fallback?: Pick<GridSummary, 'title' | 'area' | 'template' | 'rowSearch'>): DraftContent {
  const p = rec(pending);
  const search = rec(p.rowSearch ?? p.row_search ?? fallback?.rowSearch);
  return {
    title: str(p.title) || fallback?.title || '',
    area: str(p.area) || fallback?.area || '',
    template: str(p.template) || fallback?.template || null,
    command: str(search.command),
    watch: strings(search.watch),
    columns: draftColumns(p.columns),
    rows: draftRows(p.rows),
  };
}

/** A grid's own columns or rows against a draft's: what an edit adds and drops. */
export interface DraftDiff {
  columnsAdded: string[];
  columnsRetired: string[];
  rowsAdded: string[];
  rowsRemoved: string[];
}

export function draftDiff(draft: DraftContent, now: Pick<GridDetail, 'columns' | 'rows'>): DraftDiff {
  const liveCols = now.columns.filter((c) => !c.retired).map((c) => c.id);
  const liveRows = now.rows.filter((r) => !r.removed);
  const draftCols = new Set(draft.columns.map((c) => c.id));
  const draftRowIds = new Set(draft.rows.map((r) => r.id));
  const had = new Set(liveRows.map((r) => r.id));
  return {
    columnsAdded: draft.columns.map((c) => c.id).filter((id) => !liveCols.includes(id)),
    columnsRetired: liveCols.filter((id) => !draftCols.has(id)),
    rowsAdded: draft.rows.map((r) => r.id).filter((id) => !had.has(id)),
    // Rows the search finds come and go by discovery; only a manual row is
    // removed by an edit.
    rowsRemoved: liveRows.filter((r) => r.source === 'manual' && !draftRowIds.has(r.id)).map((r) => r.id),
  };
}
