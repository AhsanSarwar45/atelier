'use client';

import { useSyncExternalStore } from 'react';

import { Workflow } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Where a workflow chat's run is: its workflow, its stage and how far along. */
export interface WorkflowStage {
  run: string;
  workflow: string;
  stage: string;
  step: number | null;
  steps: number;
  status: string;
}

type Stages = Record<string, WorkflowStage>;

// One read for every chat on screen, however many rows and headers ask: the
// rail and the open chat share it. Runs move on their own, so it is read again
// every few seconds while anything is showing, like the Runs list.
const EVERY_MS = 3000;
let stages: Stages = {};
const listeners = new Set<() => void>();
let timer: number | null = null;

async function load() {
  try {
    const response = await request('/api/workbench/workflow-stages');
    if (!response.ok) return;
    const answer = (await response.json()) as { chats?: Stages };
    stages = answer.chats ?? {};
  } catch {
    // Kept as it was: the next read tries again.
    return;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    void load();
    timer = window.setInterval(() => void load(), EVERY_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** The stage chat `sessionId`'s workflow run is on; null for any other chat. */
export function useWorkflowStage(sessionId: string | null | undefined): WorkflowStage | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? stages[sessionId] ?? null : null),
    () => null,
  );
}

/** What pointing at the badge says: the workflow and how far along the run is. */
export function stageLabel(stage: WorkflowStage): string {
  const along = stage.step ? `, stage ${stage.step} of ${stage.steps}` : '';
  return `${stage.workflow} workflow${along}`;
}

/** The stage a workflow chat's run is on, in the chat's badge bar and on its row. */
export function WorkflowStageChip({ stage, testId, className }: { stage: WorkflowStage; testId: string; className?: string }) {
  return (
    <Tooltip label={stageLabel(stage)}>
      <Badge
        variant="info"
        appearance="light"
        size="sm"
        shape="circle"
        data-testid={testId}
        data-run={stage.run}
        className={cn('min-w-0 gap-1', className)}
      >
        <Workflow className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{stage.stage}</span>
      </Badge>
    </Tooltip>
  );
}
