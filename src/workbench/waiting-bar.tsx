'use client';

/**
 * What in this chat is waiting on the owner, pinned above the composer: a task
 * in review, a proposal, a plan change, a grid draft, an N/A request
 * (`waiting.ts`). Each was only on its own card, which by the time the owner
 * looks has usually scrolled away, so the chat looked finished while its agent
 * sat waiting for an answer.
 *
 * One line per item, with the same buttons its card has — the card's own
 * components, so an answer here is the answer there. A line goes when the list
 * is read again after the answer. More than two collapse to a count.
 */
import { useState, type ReactNode } from 'react';

import { ChevronDown, ChevronRight, Hand } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import { CellOwnerActions } from '@/workbench/grids/cell-detail';
import { DraftActions, useOpenGrid } from '@/workbench/grids/grid-card';
import { openTaskDetail } from '@/workbench/tasks/open-task';
import { ProposalActions, TaskOwnerActions } from '@/workbench/tasks/task-card';
import type { Task } from '@/workbench/tasks/types';
import { refreshWaiting, type Waiting } from '@/workbench/waiting';

/** More than this many fold into "N waiting for you". */
const OPEN_UP_TO = 2;

export function WaitingBar({ items, tasks, onOpenTask }: {
  items: Waiting[];
  /** The project's tasks as the chat knows them, for the task buttons. */
  tasks: ReadonlyMap<number, Task>;
  /** Opens a task's detail; the Tasks tab by default. */
  onOpenTask?: (number: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const folds = items.length > OPEN_UP_TO;
  const shown = !folds || open;
  return (
    <div data-testid="waiting-bar" data-count={items.length} className="mx-auto mb-2 w-full max-w-[110ch] px-4">
      <Panel tone="attention" inset="none" className="divide-y divide-amber-500/30">
        {folds && (
          <Button
            type="button"
            variant="ghost"
            size="md"
            data-testid="waiting-bar-toggle"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
            className="flex w-full justify-start gap-2 rounded-none px-3 text-left font-medium hover:bg-amber-500/10"
          >
            <Hand className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="flex-1">{`${items.length} waiting for you`}</span>
            {open ? <ChevronDown className="size-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0" aria-hidden="true" />}
          </Button>
        )}
        {shown && items.map((item) => (
          <WaitingLine key={item.key} item={item} task={item.task !== null ? tasks.get(item.task) : undefined} onOpenTask={onOpenTask ?? openTaskDetail} />
        ))}
      </Panel>
    </div>
  );
}

function OpenButton({ onClick }: { onClick: () => void }) {
  return <Button type="button" size="sm" variant="ghost" data-testid="waiting-open" onClick={onClick}>Open</Button>;
}

/** Opens the item's grid, or its cell, in the Tasks tab's Grids view. */
function OpenGridButton({ item }: { item: Waiting }) {
  const open = useOpenGrid(
    item.grid ? { projectId: item.projectId, slug: item.grid } : null,
    item.row && item.col ? { row: item.row, col: item.col } : undefined,
  );
  return open ? <OpenButton onClick={open} /> : null;
}

function WaitingLine({ item, task, onOpenTask }: { item: Waiting; task: Task | undefined; onOpenTask: (number: number) => void }) {
  const openTask = item.task !== null ? <OpenButton onClick={() => onOpenTask(item.task!)} /> : null;
  let actions: ReactNode = null;
  switch (item.kind) {
    case 'review':
      actions = (
        <div className="flex flex-wrap items-start gap-2">
          {task && <TaskOwnerActions task={task} only={['approve', 'reopen']} onChanged={refreshWaiting} />}
          {openTask}
        </div>
      );
      break;
    case 'amend':
      actions = (
        <div className="flex flex-wrap items-start gap-2">
          {task && <TaskOwnerActions task={task} only={['approve_amend', 'reject_amend']} onChanged={refreshWaiting} />}
          {openTask}
        </div>
      );
      break;
    case 'proposal':
      actions = item.proposal !== null && (
        <ProposalActions projectId={item.projectId} id={item.proposal} onAnswered={refreshWaiting} />
      );
      break;
    case 'grid_draft':
      actions = item.grid && (
        <DraftActions projectId={item.projectId} slug={item.grid} approveOnly onDone={refreshWaiting} extra={<OpenGridButton item={item} />} />
      );
      break;
    case 'na':
      actions = item.grid && item.row && item.col && (
        <CellOwnerActions
          projectId={item.projectId}
          slug={item.grid}
          row={item.row}
          col={item.col}
          cell={{ state: 'na_pending', proof: null }}
          recheck={false}
          onDone={refreshWaiting}
          extra={<OpenGridButton item={item} />}
        />
      );
      break;
  }
  return (
    <div
      data-testid="waiting-line"
      data-kind={item.kind}
      data-key={item.key}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2')}
    >
      <p data-testid="waiting-line-says" className="min-w-0 flex-1 basis-48 truncate text-sm">
        {item.says}
      </p>
      <div className="shrink-0">{actions}</div>
    </div>
  );
}
