'use client';

/**
 * How many things in a project wait on the owner (`waiting.ts`), drawn beside
 * the project's name wherever a project is listed and on the Tasks tab, in the
 * colour a permission question is drawn in. Nothing when nothing waits.
 */
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useWaiting, waitingInProject } from '@/workbench/waiting';

export function WaitingCount({ projectId, className }: { projectId: string; className?: string }) {
  const count = waitingInProject(useWaiting(), projectId).length;
  if (count === 0) return null;
  const label = `${count} waiting for you`;
  return (
    <Tooltip label={label}>
      <Badge
        variant="warning"
        appearance="light"
        size="sm"
        shape="circle"
        data-testid="project-waiting"
        data-count={count}
        aria-label={label}
        className={cn('shrink-0 tabular-nums', className)}
      >
        {count}
      </Badge>
    </Tooltip>
  );
}

/**
 * The same count on the Tasks tab's label, which lists these first. Smaller,
 * and with no hover label: the tab is one of three in a row of words.
 */
export function TasksTabCount({ projectId }: { projectId: string }) {
  const count = waitingInProject(useWaiting(), projectId).length;
  if (count === 0) return null;
  return (
    <Badge
      variant="warning"
      appearance="light"
      size="xs"
      shape="circle"
      data-testid="tab-tasks-waiting"
      data-count={count}
      aria-label={`${count} waiting for you`}
      className="tabular-nums"
    >
      {count}
    </Badge>
  );
}
