import type { SessionState } from '@/workbench/protocol';
import { itemCounts, itemProgress, type ItemProgress } from '@/workbench/tasks/progress';
import { isStale } from '@/workbench/tasks/stale';
import { sessionStopped, type Task } from '@/workbench/tasks/types';

/** One row of the chat's checklist: a task this chat holds, and where it stands. */
export interface ChecklistItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'paused' | 'blocked' | 'review' | 'completed' | 'cancelled';
  /** A `todo` task nobody has touched for too long (stale.ts). */
  stale?: boolean;
  /**
   * A task being worked on: its plan items, ticked as they are checked
   * (`atelier task check`), missed with a reason, or still open.
   */
  items?: ItemProgress[];
  /** For a task with plan items, how many are met out of all of them (`3/7`). */
  progress?: { met: number; total: number };
}

const WORKING = new Set<ChecklistItem['status']>(['in_progress', 'paused', 'blocked']);

/** Rows that count as finished in the panel's `n/m`. */
export const finished = (item: ChecklistItem) => item.status === 'completed' || item.status === 'cancelled';

/**
 * The checklist for one chat: the tasks it holds, by number, with live
 * statuses (docs/tasks.md, "Checklist panel"). An in-progress task in a chat
 * that is not running is shown as paused.
 */
export function checklistForTasks(tasks: Task[], sessionId: string | null, state?: SessionState, now: number = Date.now()): ChecklistItem[] {
  if (!sessionId) return [];
  return tasks
    .filter((task) => task.sessionId === sessionId)
    .sort((a, b) => a.number - b.number)
    .map((task) => {
      const status: ChecklistItem['status'] = task.status === 'todo' ? 'pending'
        : task.status === 'in_progress' ? (sessionStopped(state) ? 'paused' : 'in_progress')
          : task.status === 'blocked' ? 'blocked'
            : task.status === 'review' ? 'review'
              : task.status === 'cancelled' ? 'cancelled'
                : 'completed';
      const all = itemProgress(task);
      const items = WORKING.has(status) ? all : [];
      const { met, total } = itemCounts(all);
      return {
        id: String(task.number),
        text: `#${task.number} ${task.title}`,
        status,
        ...(isStale(task, now) ? { stale: true } : {}),
        ...(items.length ? { items } : {}),
        ...(total ? { progress: { met, total } } : {}),
      };
    });
}
