/**
 * Notes on a task (docs/tasks.md, "Notes"): shown on the task, with a box
 * to add one at any time.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { TaskCard } from '@/workbench/tasks/task-card';
import type { Task } from '@/workbench/tasks/types';

const act = vi.fn();
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, tasks: { ...real.tasks, act: (...args: unknown[]) => act(...args) } };
});
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const notes = [{ text: 'the export path also writes thumbnails', actor: 'agent', sessionId: 's2', at: 1 }];
const task = makeTask({ number: 4, status: 'done', notes } as Partial<Task>);

describe('notes on a task', () => {
  it('shows the notes, even on a finished task', () => {
    render(<TaskCard task={task} />);
    const shown = screen.getByTestId('task-notes');
    expect(within(shown).getAllByTestId('note')).toHaveLength(1);
    expect(shown.textContent).toContain('the export path also writes thumbnails');
  });

  it('adds a note', async () => {
    act.mockResolvedValue({ task: { ...task, notes: [...notes, { text: 'keep the old format', actor: 'owner', sessionId: null, at: 2 }] } });
    render(<TaskCard task={task} />);
    const shown = screen.getByTestId('task-notes');
    fireEvent.change(within(shown).getByRole('textbox', { name: 'Add a note' }), { target: { value: 'keep the old format' } });
    fireEvent.click(within(shown).getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 4, 'note', { text: 'keep the old format' }));
  });
});
