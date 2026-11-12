'use client';

/**
 * The Grids view of the Tasks tab (docs/grids.md, "Front end"): the project's
 * coverage grids, one of them as a heatmap, and a cell's detail beside it.
 */
import { useMemo, useState } from 'react';

import { ArrowLeft, Grid3x3, RefreshCw, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { ReadFailed } from '@/components/ui/read-failed';
import { Row } from '@/components/ui/row';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { grids as gridsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CellDetailPanel, failure } from '@/workbench/grids/cell-detail';
import { DraftActions, DraftView } from '@/workbench/grids/grid-card';
import { GridHeatmap, Legend, orderRows } from '@/workbench/grids/grid-heatmap';
import { newTaskLine, selectedCells, type Selection } from '@/workbench/grids/selection';
import { draftColumns, draftContent, draftDiff, type GridDetail, type GridSummary, type GridTemplate } from '@/workbench/grids/types';
import { useGrid, useGrids } from '@/workbench/grids/use-grids';
import { NewTaskButton } from '@/workbench/tasks/tasks-tab';

/** Drafts first, then the rest by lowest percent proved; discarded grids are left out. */
export function orderGrids(grids: GridSummary[]): GridSummary[] {
  return grids
    .filter((grid) => grid.status !== 'discarded')
    .sort((a, b) => {
      const da = a.status === 'draft' ? 0 : 1;
      const db = b.status === 'draft' ? 0 : 1;
      if (da !== db) return da - db;
      const pa = a.percent ?? -1;
      const pb = b.percent ?? -1;
      if (pa !== pb) return pa - pb;
      return a.title.localeCompare(b.title);
    });
}

/** How far a grid is proved: a bar and "2/34 proved". */
export function GridProgress({ grid, className }: { grid: Pick<GridSummary, 'percent' | 'counts'>; className?: string }) {
  if (grid.percent === null || grid.percent === undefined) return null;
  const proved = grid.counts?.proved ?? 0;
  const counted = grid.counts?.counted ?? 0;
  return (
    <div className={cn('flex items-center gap-2', className)} data-testid="grid-percent" data-percent={grid.percent}>
      <Progress value={grid.percent} size="sm" tone={grid.percent >= 100 ? 'success' : 'default'} aria-label="Proved" className="min-w-16 flex-1" />
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground" data-testid="grid-proved">{`${proved}/${counted} proved`}</span>
    </div>
  );
}

function Count({ n, label, tone, testId }: { n: number; label: string; tone: 'destructive' | 'warning' | 'secondary'; testId: string }) {
  if (!n) return null;
  return (
    <Badge variant={tone} appearance="light" size="sm" data-testid={testId} data-count={n} className="shrink-0">
      <span className="tabular-nums">{`${n} ${label}`}</span>
    </Badge>
  );
}

function GridListRow({ grid, onOpen }: { grid: GridSummary; onOpen: () => void }) {
  return (
    <Row gap="md" data-testid="grid-list-row" data-slug={grid.slug} onClick={onOpen} className="min-h-12 flex-wrap py-2 sm:flex-nowrap">
      <Grid3x3 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words text-sm sm:truncate">{grid.title || grid.slug}</span>
      <div className="flex w-full flex-wrap items-center gap-1.5 empty:hidden sm:w-auto sm:shrink-0">
        {grid.status === 'draft' && <Badge variant="secondary" appearance="light" size="sm"><span>Draft</span></Badge>}
        {grid.pending && <Badge variant="warning" appearance="light" size="sm" data-testid="grid-awaiting"><span>Awaiting approval</span></Badge>}
        <Count n={grid.counts?.gap ?? 0} label="gap" tone="destructive" testId="grid-gaps" />
        <Count n={grid.counts?.stale ?? 0} label="stale" tone="warning" testId="grid-stale" />
        <Count n={grid.counts?.naPending ?? 0} label="N/A pending" tone="warning" testId="grid-na-pending" />
      </div>
      {grid.status === 'approved' && <GridProgress grid={grid} className="w-full sm:w-48" />}
    </Row>
  );
}

function Templates({ templates }: { templates: GridTemplate[] }) {
  if (!templates.length) return null;
  return (
    <section className="space-y-2" data-testid="grid-templates">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Templates</h3>
      <Panel inset="none" className="divide-y divide-border/40 overflow-hidden">
        {templates.map((template) => (
          <div key={template.name} className="space-y-1 px-3 py-2" data-testid="grid-template-row">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{template.name}</span>
              <span className="text-xs text-muted-foreground">{`${template.columns.length} columns`}</span>
              {template.pending && <Badge variant="warning" appearance="light" size="sm"><span>Change awaiting approval</span></Badge>}
            </div>
            <p className="text-xs text-muted-foreground">{draftColumns(template.columns).map((c) => c.name).join(' · ')}</p>
          </div>
        ))}
      </Panel>
    </section>
  );
}

export function GridsList({ projectId, onOpen }: { projectId: string; onOpen: (slug: string) => void }) {
  const { data, loaded, error, refetch } = useGrids(projectId);
  const grids = useMemo(() => orderGrids(data?.grids ?? []), [data]);
  if (error && !data) return <ReadFailed what="Couldn't load grids." why={error.message} onRetry={refetch} />;
  if (!loaded) return <div className="flex justify-center p-6"><Spinner className="size-5 text-muted-foreground" /></div>;
  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="grids-list">
      {grids.length ? (
        <Panel inset="none" className="divide-y divide-border/40 overflow-hidden">
          {grids.map((grid) => <GridListRow key={grid.slug} grid={grid} onOpen={() => onOpen(grid.slug)} />)}
        </Panel>
      ) : (
        <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Grid3x3 className="size-6" aria-hidden />
          No grids yet
          <span className="text-xs">Ask for one in a chat with @matrix and the area to cover.</span>
        </div>
      )}
      <Templates templates={data?.templates ?? []} />
    </div>
  );
}

const ago = (at: number): string => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
};

/** The last row search, Discover and Re-check stale. */
function GridToolbar({ detail, onDone }: { detail: GridDetail; onDone: () => void }) {
  const grid = detail.grid;
  const [busy, setBusy] = useState<'discover' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the last re-check said: how many passed, and each cell that failed.
  const [rechecked, setRechecked] = useState<{ summary: string; failed: boolean } | null>(null);
  const run = grid.discovery;
  const act = async (action: 'discover' | 'verify') => {
    setBusy(action);
    setError(null);
    setRechecked(null);
    try {
      // Re-check stale re-runs only the stale cells' checks, not every proof.
      const answer = await gridsApi.act(action, { projectId: grid.projectId, slug: grid.slug }, action === 'verify' ? { staleOnly: true } : undefined);
      if (action === 'verify' && answer.summary) setRechecked({ summary: answer.summary, failed: !!answer.failed });
      onDone();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="grid-discovery">
          {!run ? 'Row search not run yet'
            : run.ok === false ? <span className="text-[var(--color-destructive-accent)]">{`Row search failed ${ago(run.at)}: ${run.error ?? 'no reason given'}`}</span>
              : `Rows searched ${ago(run.at)} · ${run.added?.length ?? 0} added · ${run.missing?.length ?? 0} missing`}
        </span>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" data-testid="grid-discover" loading={busy === 'discover'} disabled={busy !== null} onClick={() => void act('discover')}>
          <Search aria-hidden />
          Discover
        </Button>
        <Button type="button" size="xs" variant="outline" data-testid="grid-recheck-stale" loading={busy === 'verify'} disabled={busy !== null || !grid.counts?.stale} onClick={() => void act('verify')}>
          <RefreshCw aria-hidden />
          Re-check stale
        </Button>
        </div>
      </div>
      {run?.skipped && run.skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">{`Owned by other grids: ${run.skipped.map((s) => `${s.id} (${s.owner})`).join(', ')}`}</p>
      )}
      {rechecked && (
        <p
          data-testid="grid-recheck-answer"
          data-failed={rechecked.failed ? 'yes' : 'no'}
          className={cn('whitespace-pre-wrap text-xs', rechecked.failed ? 'text-[var(--color-destructive-accent)]' : 'text-muted-foreground')}
        >
          {rechecked.summary}
        </p>
      )}
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update grid. ${error}`}</div>}
    </div>
  );
}

/** "N cells (M claimable) · New task", with the cells that cannot be claimed and why. */
function SelectionBar({ detail, selection, projectId, onOpenChat, onNewChat, onClear }: {
  detail: GridDetail;
  selection: Selection;
  projectId: string;
  onOpenChat?: (sessionId: string) => void;
  onNewChat?: () => void;
  onClear: () => void;
}) {
  const drawn = orderRows(detail.rows).map((d) => d.row);
  const cells = selectedCells(selection, drawn, detail.columns.filter((c) => !c.retired), detail.cells);
  const claimable = cells.filter((c) => !c.blocker).length;
  const blocked = cells.filter((c) => c.blocker);
  const onlyColumn = selection.rows === '*' && selection.cols !== '*' && selection.cols.length === 1
    ? detail.columns.find((c) => c.id === (selection.cols as string[])[0]) : undefined;
  return (
    <div className="space-y-1 border-t border-border/60 bg-background px-4 py-2" data-testid="grid-selection">
      {onlyColumn?.proofRule && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{onlyColumn.name}: </span>{onlyColumn.proofRule}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm" data-testid="grid-selection-count">{`${cells.length} ${cells.length === 1 ? 'cell' : 'cells'}`}</span>
        {blocked.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="xs" variant="ghost" data-testid="grid-selection-claimable" className="text-muted-foreground">{`(${claimable} claimable)`}</Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-72 w-80 overflow-y-auto" data-testid="grid-selection-blocked">
              <p className="mb-1 text-xs font-medium">Not claimable</p>
              <ul className="space-y-0.5 text-xs">
                {blocked.map((c) => (
                  <li key={`${c.row.id}.${c.column.id}`}>
                    <span className="font-mono">{`${c.row.id}.${c.column.id}`}</span>
                    <span className="text-muted-foreground">{` — ${c.blocker}`}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="grid-selection-claimable">{`(${claimable} claimable)`}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={onClear}>Clear</Button>
          {onOpenChat && (
            <NewTaskButton
              projectId={projectId}
              onOpenChat={onOpenChat}
              onNewChat={onNewChat}
              line={newTaskLine(detail.grid.slug, selection)}
              disabled={!claimable}
              size="xs"
              testId="grid-new-task"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function GridScreen({ projectId, slug, cell, onShow, onOpenChat, onNewChat, onOpenTask }: {
  projectId: string;
  slug: string;
  cell: { row: string; col: string } | null;
  onShow: (where: { grid: string | null; cell?: string | null }) => void;
  onOpenChat?: (sessionId: string) => void;
  onNewChat?: () => void;
  onOpenTask?: (task: number) => void;
}) {
  const { data: detail, loaded, error, refetch } = useGrid(projectId, slug);
  const [showRetired, setShowRetired] = useState(false);
  // A selection made on purpose: a row or column name, shift-click,
  // ctrl-click or a drag. Only this one offers New task.
  const [chosen, setSelection] = useState<Selection | null>(null);
  // The cell whose detail is open is outlined too, without the selection bar.
  const selection = chosen ?? (cell ? { rows: [cell.row], cols: [cell.col] } : null);
  const rows = useMemo(() => (detail ? orderRows(detail.rows) : []), [detail]);
  const columns = useMemo(() => (detail ? detail.columns.filter((c) => showRetired || !c.retired) : []), [detail, showRetired]);
  const retired = detail?.columns.filter((c) => c.retired).length ?? 0;

  const grid = detail?.grid;
  const draft = grid?.pending ? draftContent(grid.pending, grid) : null;
  const main = (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', cell && 'hidden md:flex')}>
      <div className="space-y-2 border-b border-border/60 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button type="button" variant="ghost" size="xs" data-testid="grid-back" onClick={() => onShow({ grid: null })}>
            <ArrowLeft aria-hidden />
            Grids
          </Button>
          <h2 className="min-w-0 flex-1 text-sm font-semibold sm:truncate" data-testid="grid-title">{grid?.title || slug}</h2>
          {grid?.status === 'draft' && <Badge variant="secondary" appearance="light" size="sm"><span>Draft</span></Badge>}
          {grid?.status === 'approved' && <GridProgress grid={grid} className="w-full sm:w-56" />}
        </div>
        {grid?.status === 'approved' && detail && <GridToolbar detail={detail} onDone={refetch} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && !detail ? (
          <ReadFailed what="Couldn't load grid." why={error.message} onRetry={refetch} />
        ) : !loaded || !detail || !grid ? (
          <div className="flex justify-center p-6"><Spinner className="size-5 text-muted-foreground" /></div>
        ) : (
          <>
            {draft && (
              <Panel tone="attention" inset="md" className="space-y-3" data-testid="grid-pending">
                <p className="text-sm font-medium">{grid.status === 'draft' ? 'Draft awaiting approval' : 'Edit awaiting approval'}</p>
                <DraftView draft={draft} diff={grid.status === 'approved' ? draftDiff(draft, detail) : null} />
                <DraftActions projectId={projectId} slug={slug} onDone={refetch} />
              </Panel>
            )}
            {grid.status === 'approved' && (
              <>
                {grid.area && <p className="text-xs text-muted-foreground">{grid.area}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Legend />
                  {retired > 0 && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={showRetired} onCheckedChange={setShowRetired} data-testid="grid-show-retired" />
                      {`Show retired (${retired})`}
                    </label>
                  )}
                </div>
                {rows.length ? (
                  <GridHeatmap
                    rows={rows}
                    columns={columns}
                    cells={detail.cells}
                    selection={selection}
                    onSelect={setSelection}
                    onOpenCell={(row, column) => {
                      setSelection(null);
                      // A reference row's cells are the owner grid's; its detail is there.
                      if (row.kind === 'reference' && row.ref) onShow({ grid: row.ref.grid, cell: `${row.ref.row}:${column.id}` });
                      else onShow({ grid: slug, cell: `${row.id}:${column.id}` });
                    }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No rows yet</p>
                )}
              </>
            )}
          </>
        )}
      </div>
      {detail && chosen && grid?.status === 'approved' && (
        <SelectionBar
          detail={detail}
          selection={chosen}
          projectId={projectId}
          onOpenChat={onOpenChat}
          onNewChat={onNewChat}
          onClear={() => setSelection(null)}
        />
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1" data-testid="grid-view" data-slug={slug}>
      {main}
      {cell && (
        <aside className="flex min-h-0 w-full flex-col border-l border-border/60 md:w-[min(36rem,45%)]">
          <CellDetailPanel
            projectId={projectId}
            slug={slug}
            row={cell.row}
            col={cell.col}
            gridName={grid?.title || slug}
            onClose={() => onShow({ grid: slug, cell: null })}
            onOpenTask={onOpenTask}
          />
        </aside>
      )}
    </div>
  );
}

/**
 * The Grids view: the list, or one grid when the address names it, with the
 * cell it names open beside it.
 */
export default function GridsView({ projectId, grid, cell, onShow, onOpenChat, onNewChat, onOpenTask }: {
  projectId: string;
  grid: string | null;
  cell: { row: string; col: string } | null;
  /** Shows another grid or cell, or the list (`grid: null`). */
  onShow: (where: { grid: string | null; cell?: string | null }) => void;
  onOpenChat?: (sessionId: string) => void;
  onNewChat?: () => void;
  onOpenTask?: (task: number) => void;
}) {
  if (grid) {
    return (
      <GridScreen
        key={grid}
        projectId={projectId}
        slug={grid}
        cell={cell}
        onShow={onShow}
        onOpenChat={onOpenChat}
        onNewChat={onNewChat}
        onOpenTask={onOpenTask}
      />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <GridsList projectId={projectId} onOpen={(slug) => onShow({ grid: slug })} />
    </div>
  );
}
