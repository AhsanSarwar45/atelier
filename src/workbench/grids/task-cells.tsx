'use client';

/**
 * The grid cells a task claimed, on its card (docs/grids.md, "Claims"): each
 * one's live state, opening the cell when clicked. A task's JSON carries its
 * cells; they are read again whenever the project's grids change, since a
 * proof moves a cell without moving the task.
 */
import { useEffect, useState } from 'react';

import { Grid3x3 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

import { gridBadge, ReferenceBadge } from '@/components/reference-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { addressWith } from '@/lib/address';
import { tasks as tasksApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CellSquare } from '@/workbench/grids/grid-heatmap';
import { CELL_STATES, STATE_LABEL, type CellState } from '@/workbench/grids/types';
import { gridsChangedFor } from '@/workbench/grids/use-grids';
import { onWorkbench } from '@/workbench/live-wire';
import type { ClaimShape, Task, TaskCell, TaskProposal } from '@/workbench/tasks/types';

const isState = (state: string | null): state is CellState => !!state && (CELL_STATES as readonly string[]).includes(state);

function Heading({ count }: { count: number }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {count === 1 ? 'Grid cell' : `Grid cells (${count})`}
    </span>
  );
}

const KIND: Record<ClaimShape['kind'], string> = { row: 'row', col: 'column', grid: 'grid' };

/** A task's cells as one shape: `Glare row · 5 cells`, `Ground-truth tests column · 4 cells`. */
export function claimShapeLabel(shape: ClaimShape): string {
  return `${shape.name} ${KIND[shape.kind] ?? shape.kind} · ${shape.count} ${shape.count === 1 ? 'cell' : 'cells'}`;
}

/** The grid id a shape covers: `camera.glare.*`, `camera.*.gpu`, or the grid. */
const shapeId = (shape: ClaimShape): string =>
  shape.kind === 'row' ? `${shape.grid}.${shape.id}.*` : shape.kind === 'col' ? `${shape.grid}.*.${shape.id}` : shape.grid;

/** The shape as a link to its grid, with what it covers selected. */
export function ClaimShapeLink({ shape, projectId, className }: { shape: ClaimShape; projectId: string; className?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <Button
      type="button"
      variant="ghost"
      size="inherit"
      data-testid="task-claim-shape"
      data-shape={shapeId(shape)}
      onClick={() => router.push(addressWith(params, { id: projectId, tab: 'tasks', task: null, view: 'grids', grid: shape.grid, cell: null }))}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground hover:underline', className)}
    >
      <Grid3x3 aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{claimShapeLabel(shape)}</span>
    </Button>
  );
}

/** How many of the cells are in each state: `1 proved · 4 in progress`. */
function stateCounts(cells: TaskCell[]): string {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    const label = isState(cell.state) ? STATE_LABEL[cell.state] : 'Removed';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label.toLowerCase()}`).join(' · ');
}

/** A task's cells, kept current. Nothing when it claimed none. */
export function TaskCells({ task }: { task: Pick<Task, 'projectId' | 'number' | 'status' | 'updatedAt' | 'cells' | 'claimShape'> }) {
  const [cells, setCells] = useState<TaskCell[]>(task.cells ?? []);
  const { projectId, number } = task;
  const claims = (task.cells ?? []).length > 0;
  // A finished task has let go of every cell; saying so on each is noise.
  const finished = task.status === 'done' || task.status === 'cancelled';

  // The task moved: take its cells as it hands them over.
  useEffect(() => { setCells(task.cells ?? []); }, [task.cells, task.updatedAt]);

  useEffect(() => {
    if (!claims) return;
    let alive = true;
    const off = onWorkbench({
      frame: (data) => {
        if (!gridsChangedFor(data, projectId)) return;
        tasksApi.get(projectId, number)
          .then((found) => { if (alive) setCells(found.task.cells ?? []); })
          .catch(() => {});
      },
      dropped: () => {},
    });
    return () => { alive = false; off(); };
  }, [claims, projectId, number]);

  if (cells.length === 0) return null;
  // A whole row, column or grid is said as one line rather than cell by cell.
  if (task.claimShape) return (
    <section className="space-y-1.5" data-testid="task-cells">
      <Heading count={cells.length} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <ClaimShapeLink shape={task.claimShape} projectId={projectId} className="text-sm text-foreground" />
        <span data-testid="task-claim-states" className="text-xs text-muted-foreground">{stateCounts(cells)}</span>
      </div>
    </section>
  );
  return (
    <section className="space-y-1.5" data-testid="task-cells">
      <Heading count={cells.length} />
      <ul className="space-y-1">
        {cells.map((cell) => {
          const state = isState(cell.state) ? cell.state : null;
          return (
            <li
              key={`${cell.grid}.${cell.row}.${cell.col}`}
              data-testid="task-cell"
              data-cell={`${cell.grid}.${cell.row}.${cell.col}`}
              data-state={cell.state ?? 'gone'}
              className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
            >
              <CellSquare look={state ?? 'unchecked'} />
              <ReferenceBadge reference={gridBadge(`${cell.grid}.${cell.row}.${cell.col}`)} projectId={projectId} size="xs" testId="task-cell-open" />
              <span className="text-muted-foreground">{state ? STATE_LABEL[state] : 'Removed'}</span>
              {!cell.claimed && state && !finished && <Badge variant="outline" size="sm"><span>Released</span></Badge>}
              {cell.reason && <span className="basis-full pl-5 text-muted-foreground">{cell.reason}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The cells a proposed task would claim. */
export function ProposalCells({ proposal }: { proposal: Pick<TaskProposal, 'projectId' | 'cells'> }) {
  const cells = proposal.cells ?? [];
  if (cells.length === 0) return null;
  return (
    <section className="space-y-1.5" data-testid="proposal-cells">
      <Heading count={cells.length} />
      <div className="flex flex-wrap gap-1.5">
        {cells.map((cell) => (
          <ReferenceBadge
            key={`${cell.grid}.${cell.row}.${cell.col}`}
            reference={gridBadge(`${cell.grid}.${cell.row}.${cell.col}`)}
            projectId={proposal.projectId}
            size="xs"
            testId="proposal-cell"
          />
        ))}
      </div>
    </section>
  );
}
