'use client';

/**
 * The `grid` chat widget (docs/grids.md, "Cards"): the line printed by every
 * `atelier grid` change. Every line is a read-only summary: nothing in a grid
 * waits for the owner. Every line reads its grid again on `grids.changed`, so
 * a line printed long ago shows where things stand now.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  AlertTriangle, Check, ChevronDown, CircleCheckBig, CircleSlash, Columns3, Grid3x3, RotateCcw, Search, type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { addressWith } from '@/lib/address';
import { grids as gridsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  cellLook,
  LOOK_LABEL,
  type CellDetail,
  type GridSummary,
  type GridWidget,
} from '@/workbench/grids/types';
import { gridsChangedFor, useGrid, useGrids } from '@/workbench/grids/use-grids';
import { onWorkbench } from '@/workbench/live-wire';

/* ------------------------------------------------------------------ pieces */

function IdList({ ids, names, tone }: { ids: string[]; names?: Record<string, string>; tone?: 'add' | 'drop' }) {
  if (!ids.length) return null;
  return (
    <span className={cn('text-xs', !names && 'font-mono', tone === 'add' && 'text-[var(--color-success-accent)]', tone === 'drop' && 'text-[var(--color-destructive-accent)]')}>
      {ids.map((id) => names?.[id] ?? id).join(', ')}
    </span>
  );
}

/** A grid's percent proved as a bar and a number. */
export function PercentBar({ percent, className }: { percent: number | null; className?: string }) {
  if (percent === null || percent === undefined) return null;
  return (
    <div className={cn('flex items-center gap-2', className)} data-testid="grid-percent" data-percent={percent}>
      <Progress value={percent} size="sm" tone={percent >= 100 ? 'success' : 'default'} aria-label="Proved" className="min-w-16 flex-1" />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{`${percent}%`}</span>
    </div>
  );
}

/** A way to open the grid, or one cell of it, in the Tasks tab's Grids view. */
export function useOpenGrid(grid: Pick<GridSummary, 'projectId' | 'slug'> | null | undefined, cell?: { row: string; col: string }): (() => void) | null {
  const router = useRouter();
  const params = useSearchParams();
  if (!grid) return null;
  return () => router.push(addressWith(params, {
    id: grid.projectId,
    tab: 'tasks',
    view: 'grids',
    grid: grid.slug,
    cell: cell ? `${cell.row}:${cell.col}` : null,
    task: null,
  }));
}

/** Opens the grid in the Tasks tab's Grids view. */
function OpenGrid({ grid, cell }: { grid: Pick<GridSummary, 'projectId' | 'slug'>; cell?: { row: string; col: string } }) {
  const open = useOpenGrid(grid, cell);
  return <Button type="button" size="sm" variant="ghost" data-testid="grid-open" onClick={() => open?.()}>Open grid</Button>;
}

/* ------------------------------------------------------------------ the row */

type Tone = 'done' | 'warn' | 'plain';

/**
 * One line in a chat for each `atelier grid` change, the way a task's later
 * changes are drawn (task-event-row.tsx): an icon, what happened, and which
 * cell or grid, e.g. `✓ Proved  Glare × Ground truth · camera`. The chevron
 * unfolds the details.
 */
function GridLine({ event, icon: Icon, tone, label, what, onOpen, answered, more }: {
  event: string;
  icon: LucideIcon;
  tone: Tone;
  label: string;
  what: string;
  onOpen?: (() => void) | null;
  answered?: string;
  more?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel inset="none" data-testid="grid-card" data-event={event} className="my-1 max-w-4xl">
      <div className="space-y-1 px-3 py-1.5">
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          <Icon aria-hidden className={cn('size-4 shrink-0', tone === 'done' ? 'text-[var(--color-success-accent)]'
            : tone === 'warn' ? 'text-[var(--color-warning-accent)]' : 'text-muted-foreground')} />
          <span data-testid="grid-card-label" className="shrink-0 text-sm">{label}</span>
          {onOpen ? (
            <Button type="button" variant="ghost" size="inherit" data-testid="grid-card-what" onClick={onOpen}
              className="block min-w-0 flex-1 truncate text-left text-sm font-normal text-muted-foreground hover:bg-transparent hover:underline">
              {what}
            </Button>
          ) : <span data-testid="grid-card-what" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{what}</span>}
          {answered && <Badge variant="secondary" appearance="light" size="sm" data-testid="grid-card-answer" className="shrink-0"><span>{answered}</span></Badge>}
          {more && (
            <Button type="button" variant="ghost" size="none" data-testid="grid-card-toggle" aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'} className="-my-1 size-6 shrink-0 text-muted-foreground" onClick={() => setOpen((o) => !o)}>
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </Button>
          )}
        </div>
      </div>
      {open && more && (
        <div data-testid="grid-card-more" className="space-y-3 border-t border-border/60 px-3 py-2">
          {more}
        </div>
      )}
    </Panel>
  );
}

/** A card about one grid: every card but a template's. */
type GridCardWidget = GridWidget & { grid: GridSummary };

/** A draft is live at once: the line says so and opens the grid. */
function DraftRow({ widget }: { widget: GridCardWidget }) {
  const snapshot = widget.grid;
  const { data } = useGrid(snapshot.projectId, snapshot.slug);
  const grid = data?.grid ?? snapshot;
  const open = useOpenGrid(grid);
  return <GridLine event="draft" icon={Grid3x3} tone="plain" label="Grid saved" what={grid.title || grid.slug} onOpen={open} />;
}

/** A template change applies at once: the line says what it changed. */
function TemplateRow({ widget }: { widget: GridWidget }) {
  const template = widget.template;
  if (!template) return null;
  const change = template.change ?? null;
  const lists = change && (change.added.length + change.removed.length + change.changed.length + change.affects.length + change.clashes.length > 0);
  const more = lists ? (
    <div className="space-y-1 text-xs" data-testid="grid-template">
      {change.added.length > 0 && <div>Columns added: <IdList ids={change.added} tone="add" /></div>}
      {change.removed.length > 0 && <div>Columns removed: <IdList ids={change.removed} tone="drop" /></div>}
      {change.changed.length > 0 && <div>Columns changed: <IdList ids={change.changed} /></div>}
      {change.affects.length > 0 && (
        <p className="text-muted-foreground" data-testid="grid-template-affected">{`Changes ${change.affects.join(', ')}`}</p>
      )}
      {change.clashes.length > 0 && (
        <p className="text-[var(--color-warning-accent)]">
          {`Kept as the grid's own column: ${change.clashes.map((c) => `${c.grid}.${c.column}`).join(', ')}`}
        </p>
      )}
    </div>
  ) : null;
  return <GridLine event="template" icon={Columns3} tone="plain" label="Template changed" what={template.name} more={more} />;
}

/** A cell as it stands now, read again on `grids.changed`. */
function useLiveCell(projectId: string, slug: string, row: string, col: string): [CellDetail | null, () => void] {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    gridsApi.cell(projectId, slug, row, col).then((found) => { if (alive) setDetail(found); }).catch(() => {});
    return () => { alive = false; };
  }, [projectId, slug, row, col, round]);
  useEffect(() => onWorkbench({
    frame: (data) => { if (gridsChangedFor(data, projectId)) setRound((n) => n + 1); },
    dropped: () => {},
  }), [projectId]);
  return [detail, () => setRound((n) => n + 1)];
}

const CELL_EVENT: Record<string, [string, LucideIcon, Tone]> = {
  prove: ['Proved', Check, 'done'],
  pass: ['Audit passed', CircleCheckBig, 'done'],
  reopen: ['Reopened', RotateCcw, 'warn'],
  na: ['Marked N/A', CircleSlash, 'plain'],
};

function CellRow({ widget }: { widget: GridCardWidget }) {
  const snapshot = widget.cell!;
  const grid = widget.grid;
  const [detail] = useLiveCell(grid.projectId, grid.slug, snapshot.row, snapshot.col);
  const open = useOpenGrid(grid, snapshot);
  const cell = { ...snapshot, ...(detail?.cell ?? {}) };
  const state = cell.state ?? 'unchecked';
  const na = widget.event === 'na';
  const summary = cell.proof?.summary ?? cell.proofSummary;
  const name = detail ? `${detail.row.name} × ${detail.column.name}` : `${snapshot.row} × ${snapshot.col}`;
  const [label, icon, tone] = CELL_EVENT[widget.event] ?? [EVENT_LABEL[widget.event] ?? widget.event, Grid3x3, 'plain' as Tone];
  // A line that no longer stands says where the cell is now.
  const moved = detail && widget.event !== 'reopen' && state !== (na ? 'na' : 'proved') ? LOOK_LABEL[cellLook({ state, stale: !!cell.stale })] : '';
  const stale = !na && detail && state === 'proved' && cell.stale ? 'Stale' : '';
  const reason = cell.reason ?? snapshot.reason;
  const more = (
    <div className="space-y-2" data-testid="grid-cell-card">
      {reason && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" data-testid="grid-cell-reason">{reason}</p>}
      {summary && !na && <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>}
      <OpenGrid grid={grid} cell={snapshot} />
    </div>
  );
  return (
    <GridLine event={widget.event} icon={icon} tone={tone} label={label} what={`${name} · ${grid.slug}`} onOpen={open}
      answered={moved || stale || undefined} more={more} />
  );
}

function AuditRow({ widget }: { widget: GridCardWidget }) {
  const audit = widget.audit;
  const open = useOpenGrid(widget.grid);
  const reopened = audit?.reopened ?? 0;
  const cells = audit?.cells ?? [];
  return (
    <GridLine event="audit" icon={reopened ? AlertTriangle : CircleCheckBig} tone={reopened ? 'warn' : 'done'}
      label={`Audit: ${audit?.passed ?? 0} passed · ${reopened} reopened`} what={widget.grid.slug} onOpen={open}
      more={cells.length > 0 ? (
        <ul className="space-y-1 text-sm" data-testid="grid-audit">
          {cells.map((c) => (
            <li key={`${c.row}.${c.col}`}>
              <span className="font-mono text-xs">{`${c.row}.${c.col}`}</span>
              {c.reason && <span className="text-muted-foreground">{` — ${c.reason}`}</span>}
            </li>
          ))}
        </ul>
      ) : null} />
  );
}

function DiscoverRow({ widget, live }: { widget: GridCardWidget; live: GridSummary }) {
  const run = widget.grid.discovery ?? live.discovery;
  const open = useOpenGrid(widget.grid);
  const failed = run?.ok === false;
  const label = !run ? 'Row search: no run yet' : failed ? 'Row search failed'
    : `Row search: ${run.added?.length ?? 0} added · ${run.missing?.length ?? 0} missing · ${run.back?.length ?? 0} back`;
  const lists = run && !failed && ((run.added?.length ?? 0) + (run.missing?.length ?? 0) + (run.skipped?.length ?? 0) > 0);
  return (
    <GridLine event="discover" icon={failed ? AlertTriangle : Search} tone={failed ? 'warn' : 'plain'} label={label}
      what={widget.grid.slug} onOpen={open}
      more={failed ? (
        <p className="text-sm text-[var(--color-destructive-accent)]" data-testid="grid-discover">{run?.error ?? 'No reason given'}</p>
      ) : lists ? (
        <div className="space-y-1 text-xs" data-testid="grid-discover">
          {run.added && run.added.length > 0 && <div>Added: <IdList ids={run.added} tone="add" /></div>}
          {run.missing && run.missing.length > 0 && <div>Missing: <IdList ids={run.missing} tone="drop" /></div>}
          {run.skipped && run.skipped.length > 0 && (
            <div className="text-muted-foreground">{`Owned by other grids: ${run.skipped.map((s) => `${s.id} (${s.owner})`).join(', ')}`}</div>
          )}
        </div>
      ) : null} />
  );
}

function OtherRow({ widget }: { widget: GridCardWidget }) {
  const open = useOpenGrid(widget.grid);
  return <GridLine event={widget.event} icon={Grid3x3} tone="plain" label={EVENT_LABEL[widget.event] ?? 'Grid changed'} what={widget.grid.slug} onOpen={open} />;
}

/* ------------------------------------------------------------------ the card */

const EVENT_LABEL: Record<string, string> = {
  draft: 'Grid saved', template: 'Template changed', prove: 'Proved', na: 'Marked N/A', audit: 'Audit',
  reopen: 'Reopened', pass: 'Audit passed', discover: 'Row search',
};

/** The `grid` chat widget: one line per change (docs/grids.md, "Cards"). */
export function GridCard({ widget }: { widget: GridWidget }) {
  const template = widget.event === 'template';
  const discover = widget.event === 'discover';
  const { data } = useGrids(discover ? widget.grid?.projectId ?? null : null);
  // Every card but a template's is about a grid; the reader refuses one without.
  const about = widget.grid ? widget as GridCardWidget : null;
  if (template) return <TemplateRow widget={widget} />;
  if (!about) return null;
  if (widget.event === 'draft') return <DraftRow widget={about} />;
  if (widget.event === 'audit') return <AuditRow widget={about} />;
  if (discover) return <DiscoverRow widget={about} live={data?.grids.find((g) => g.slug === about.grid.slug) ?? about.grid} />;
  if (widget.cell) return <CellRow widget={about} />;
  return <OtherRow widget={about} />;
}
