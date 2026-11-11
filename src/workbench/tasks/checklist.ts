import type { SessionState } from '@/workbench/protocol';
import { sessionStopped, type Task } from '@/workbench/tasks/types';

/** One row of the chat's checklist: a task this chat holds, and where it stands. */
export interface ChecklistItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'paused' | 'blocked' | 'review' | 'completed' | 'cancelled';
}

/** Rows that count as finished in the panel's `n/m`. */
export const finished = (item: ChecklistItem) => item.status === 'completed' || item.status === 'cancelled';

/**
 * The checklist for one chat: the tasks it holds, by number, with live
 * statuses (docs/tasks.md, "Checklist panel"). An in-progress task in a chat
 * that is not running is shown as paused.
 */
export function checklistForTasks(tasks: Task[], sessionId: string | null, state?: SessionState): ChecklistItem[] {
  if (!sessionId) return [];
  return tasks
    .filter((task) => task.sessionId === sessionId)
    .sort((a, b) => a.number - b.number)
    .map((task) => ({
      id: String(task.number),
      text: `#${task.number} ${task.title}`,
      status: task.status === 'todo' ? 'pending'
        : task.status === 'in_progress' ? (sessionStopped(state) ? 'paused' : 'in_progress')
          : task.status === 'blocked' ? 'blocked'
            : task.status === 'review' ? 'review'
              : task.status === 'cancelled' ? 'cancelled'
                : 'completed',
    }));
}
