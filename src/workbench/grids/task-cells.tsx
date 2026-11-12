'use client';

/**
 * The grid cells a task claimed, on its card (docs/grids.md, "Claims"): each
 * one's live state, opening the cell when clicked. A task's JSON carries its
 * cells; they are read again whenever the project's grids change, since a
 * proof moves a cell without moving the task.
 */
import { useEffect, useState } from 'react';

import { gridBadge, ReferenceBadge } from '@/components/reference-badge';
import { Badge } from '@/components/ui/badge';
import { tasks as tasksApi } from '@/lib/api';
import { CellSquare } from '@/workbench/grids/grid-heatmap';
import { CELL_STATES, STATE_LABEL, type CellState } from '@/workbench/grids/types';
import { gridsChangedFor } from '@/workbench/grids/use-grids';
import { onWorkbench } from '@/workbench/live-wire';
import type { Task, TaskCell, TaskProposal } from '@/workbench/tasks/types';

const isState = (state: string | null): state is CellState => !!state && (CELL_STATES as readonly string[]).includes(state);

function Heading({ count }: { count: number }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {count === 1 ? 'Grid cell' : `Grid cells (${count})`}
    </span>
  );
}

/** A task's cells, kept current. Nothing when it claimed none. */
export function TaskCells({ task }: { task: Pick<Task, 'projectId' | 'number' | 'status' | 'updatedAt' | 'cells'> }) {
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
