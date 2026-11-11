import type { Task } from '@/workbench/tasks/types';

/** A task with every field filled, overridden as a test needs. */
export function makeTask(over: Partial<Task> = {}): Task {
  return {
    projectId: 'p1',
    number: 1,
    type: 'feature',
    title: 'A task',
    why: 'Because',
    status: 'todo',
    sessionId: 's1',
    sessionTitle: 'Chat one',
    createdBy: 's1',
    plan: {},
    result: null,
    shortfalls: false,
    blocked: null,
    cancelReason: null,
    pendingAmend: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}
