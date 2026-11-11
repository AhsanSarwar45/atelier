import { describe, expect, it } from 'vitest';

import { TasksResponseSchema } from '@/lib/api-schemas';

const task = { projectId: 'p', number: 1, type: 'feature', title: 'A task', status: 'todo' };

describe('checking what the server answered', () => {
  it('lets a task list and extra fields through, and hands the value back', () => {
    const answer = { tasks: [{ ...task, something_new: true }] };
    expect(TasksResponseSchema.parse(answer)).toBe(answer);
  });

  it('refuses a task with a field of the wrong kind, and says where', () => {
    const bad = { tasks: [task, { ...task, number: 'two' }] };
    expect(() => TasksResponseSchema.parse(bad)).toThrow('tasks[1].number: expected number, got string');
  });
});
