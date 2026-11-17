'use client';

/**
 * Rows whose cases wait for the owner (docs/grids.md, "Cases"): each cell's
 * column checks and its own cases with their commands resolved, the coverage
 * review's gaps with how each was answered, and Approve cases for the row.
 */
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { grids as gridsApi } from '@/lib/api';
import { failure } from '@/workbench/grids/cell-detail';
import type { GridCell, GridColumn, GridDetail, GridRow } from '@/workbench/grids/types';

/** Rows with at least one reviewed cell whose cases the owner has not approved. */
export function rowsAwaitingCases(detail: GridDetail): GridRow[] {
  const live = new Set(detail.columns.filter((c) => !c.retired).map((c) => c.id));
  return detail.rows.filter((row) => !row.removed && row.kind !== 'reference'
    && detail.cells.some((cell) => cell.row === row.id && live.has(cell.col) && cell.step === 'reviewed'));
}

function Command({ text }: { text: string }) {
  return <code className="block whitespace-pre-wrap break-all rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">{text}</code>;
}

function CellCases({ cell, column }: { cell: GridCell; column: GridColumn }) {
  const own = new Set((cell.cases ?? []).map((c) => c.id));
  const fromColumn = (cell.checks ?? []).filter((check) => !own.has(String(check.name ?? '')));
  const answers = cell.review?.answers ?? {};
  const gaps = (cell.review?.rounds ?? []).flat();
  return (
    <div className="space-y-2 px-3 py-2" data-testid="grid-row-cases-cell" data-col={cell.col} data-step={cell.step ?? ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{column.name}</span>
        <Badge variant={cell.step === 'reviewed' ? 'success' : 'secondary'} appearance="light" size="sm">
          <span>{cell.step === 'reviewed' ? 'Reviewed' : cell.step === 'approved' ? 'Approved' : 'Needs cases'}</span>
        </Badge>
      </div>
      {fromColumn.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Column checks</p>
          {fromColumn.map((check) => <Command key={String(check.name)} text={String(check.command ?? '')} />)}
        </div>
      )}
      {(cell.cases ?? []).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cases</p>
          {(cell.cases ?? []).map((c) => (
            <div key={c.id} className="space-y-0.5" data-testid="grid-row-case">
              <p className="text-xs">
                <span className="font-mono font-medium">{c.id}</span>
                <span className="text-muted-foreground">{` — given ${c.given ?? ''}, when ${c.when ?? ''}, then ${c.then ?? ''}`}</span>
              </p>
              {c.command && <Command text={c.command} />}
            </div>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Review gaps</p>
          <ul className="space-y-0.5 text-xs">
            {gaps.map((gap) => {
              const answer = answers[gap.id];
              return (
                <li key={gap.id} data-testid="grid-row-case-gap">
                  <span>{gap.scenario}</span>
                  <span className="text-muted-foreground">
                    {answer?.case ? ` — covered by ${answer.case}` : answer?.dismissed ? ` — dismissed: ${answer.dismissed}` : ' — open'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function RowCases({ detail, row, onDone }: { detail: GridDetail; row: GridRow; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const columns = detail.columns.filter((c) => !c.retired);
  const cells = columns
    .map((column) => ({ column, cell: detail.cells.find((c) => c.row === row.id && c.col === column.id) }))
    .filter((x): x is { column: GridColumn; cell: GridCell } => !!x.cell && x.cell.step !== 'na');
  const waiting = cells.filter(({ cell }) => cell.step === 'cases').length;
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await gridsApi.act('approve_cases', { projectId: detail.grid.projectId, slug: detail.grid.slug, row: row.id });
      onDone();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel tone="attention" inset="none" className="overflow-hidden" data-testid="grid-row-cases" data-row={row.id}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{row.name}</span>
        {waiting > 0 && <span className="text-xs text-muted-foreground">{`${waiting} ${waiting === 1 ? 'cell needs' : 'cells need'} review`}</span>}
        <Button type="button" size="xs" data-testid="grid-approve-cases" loading={busy} disabled={busy || waiting > 0} onClick={() => void approve()}>
          Approve cases
        </Button>
      </div>
      <div className="divide-y divide-border/40">
        {cells.map(({ column, cell }) => <CellCases key={column.id} cell={cell} column={column} />)}
      </div>
      {error && <div role="alert" className="px-3 py-2 text-xs text-destructive">{`Couldn't approve cases. ${error}`}</div>}
    </Panel>
  );
}

export function RowCasesList({ detail, onDone }: { detail: GridDetail; onDone: () => void }) {
  const rows = rowsAwaitingCases(detail);
  if (!rows.length) return null;
  return (
    <section className="space-y-2" data-testid="grid-cases-awaiting">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cases awaiting approval</h3>
      {rows.map((row) => <RowCases key={row.id} detail={detail} row={row} onDone={onDone} />)}
    </section>
  );
}
