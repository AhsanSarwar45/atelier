import type { Task } from '@/workbench/tasks/types';

/** How long a `todo` task may sit untouched before it is called stale. */
export const STALE_DAYS = 14;
export const STALE_AFTER_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/** The reason a stale task's one-click Cancel starts with. */
export const STALE_REASON = `Stale: not touched for ${STALE_DAYS} days`;

/**
 * A task nobody has started and nobody has touched for `STALE_DAYS`. Only
 * `todo` counts: work in progress, blocked or in review is somebody's.
 */
export function isStale(task: Pick<Task, 'status' | 'updatedAt'>, now: number = Date.now()): boolean {
  return task.status === 'todo' && now - task.updatedAt > STALE_AFTER_MS;
}
