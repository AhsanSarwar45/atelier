import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TodoPanel } from '@/workbench/chat-tab';
import { checklistForTasks, type ChecklistItem } from '@/workbench/tasks/checklist';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const active: ChecklistItem[] = [
  { id: '1', text: '#1 Find the cause', status: 'completed' },
  { id: '2', text: '#2 Fix the screen', status: 'in_progress' },
];

describe('the live checklist', () => {
  const tasks = [
    makeTask({ number: 3, title: 'Later piece', status: 'todo' }),
    makeTask({ number: 1, title: 'Finished piece', status: 'done' }),
    makeTask({ number: 2, title: 'Current piece', status: 'in_progress' }),
    makeTask({ number: 4, title: 'Stuck piece', status: 'blocked' }),
    makeTask({ number: 5, title: 'Waiting piece', status: 'review' }),
    makeTask({ number: 6, title: 'Dropped piece', status: 'cancelled' }),
    makeTask({ number: 7, title: 'Another chat', status: 'in_progress', sessionId: 's2' }),
    makeTask({ number: 8, title: 'Nobody', status: 'todo', sessionId: null }),
  ];

  it("lists this chat's tasks in number order with their statuses", () => {
    // Read at the moment the tasks were made, so none of them is stale yet.
    expect(checklistForTasks(tasks, 's1', 'idle', 1)).toEqual([
      { id: '1', text: '#1 Finished piece', status: 'completed' },
      { id: '2', text: '#2 Current piece', status: 'in_progress' },
      { id: '3', text: '#3 Later piece', status: 'pending' },
      { id: '4', text: '#4 Stuck piece', status: 'blocked' },
      { id: '5', text: '#5 Waiting piece', status: 'review' },
      { id: '6', text: '#6 Dropped piece', status: 'cancelled' },
    ]);
  });

  it('shows an in-progress task as paused when its chat is not running', () => {
    for (const state of ['stopped', 'errored', 'dormant'] as const) {
      expect(checklistForTasks(tasks, 's1', state).find((item) => item.id === '2')?.status).toBe('paused');
    }
  });

  it('has no checklist without a chat or without tasks', () => {
    expect(checklistForTasks(tasks, null)).toEqual([]);
    expect(checklistForTasks(tasks, 's9')).toEqual([]);
  });

  it('marks a stale task', () => {
    render(<TodoPanel items={[{ id: '3', text: '#3 Forgotten', status: 'pending', stale: true }, { id: '4', text: '#4 Fresh', status: 'pending' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /tasks/i }));
    expect(screen.getAllByTestId('todo-stale')).toHaveLength(1);
    expect(screen.getByText('#3 Forgotten').parentElement).toContainElement(screen.getByTestId('todo-stale'));
  });

  it('marks a cancelled task with its own icon, not a tick, and leaves it out of the count', () => {
    render(<TodoPanel items={[...active, { id: '3', text: '#3 Dropped', status: 'cancelled' }, { id: '4', text: '#4 Stuck', status: 'blocked' }]} />);
    expect(screen.getByTestId('todo-count')).toHaveTextContent('1 of 3 done');
    fireEvent.click(screen.getByRole('button', { name: /tasks/i }));
    expect(screen.getByText('#3 Dropped')).not.toHaveClass('line-through');
    const dropped = screen.getAllByTestId('todo-item').find((item) => item.dataset.todoStatus === 'cancelled')!;
    expect(dropped.querySelector('[data-testid="todo-cancelled"]')).not.toBeNull();
    expect(dropped.querySelector('button[role="checkbox"]')).toBeNull();
    expect(screen.getByText('Blocked')).toBeVisible();
  });

  it('shows a chip on a task waiting on the owner', () => {
    render(<TodoPanel items={[
      { id: '1', text: '#1 Changing', status: 'paused', planChange: true },
      { id: '2', text: '#2 Finished', status: 'review' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /tasks/i }));
    expect(screen.getAllByTestId('todo-waiting').map((chip) => chip.textContent)).toEqual(['Plan change', 'In review']);
    expect(checklistForTasks([makeTask({ number: 1, status: 'in_progress', pendingAmend: { outcome: 'x', criteria: [] } })], 's1', 'idle', 1)[0]!.planChange).toBe(true);
  });

  it('shows the current task on the folded row, paused ones included', () => {
    render(<TodoPanel items={[{ id: '1', text: '#1 Waiting', status: 'pending' }, { id: '2', text: '#2 Paused', status: 'paused' }]} />);
    expect(screen.getByRole('button', { name: /tasks/i })).toHaveTextContent('#2 Paused');
  });

  it('starts as one row on an opened chat and unfolds when asked', () => {
    render(<TodoPanel items={active} />);

    const toggle = screen.getByRole('button', { name: /tasks/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('todo-panel')).toHaveAttribute('data-expanded', 'no');
    expect(screen.getByText('1 of 2 done')).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('#2 Fix the screen')).toBeVisible();
  });

  it('caps the unfolded list so a long epic scrolls instead of filling the screen', () => {
    render(<TodoPanel items={active} />);
    fireEvent.click(screen.getByRole('button', { name: /tasks/i }));

    const list = document.getElementById('active-checklist-items');
    expect(list?.className).toContain('overflow-y-auto');
    expect(list?.className).toMatch(/max-h-/);
  });

  it('automatically collapses when the last item completes', () => {
    const view = render(<TodoPanel items={active} />);
    fireEvent.click(screen.getByRole('button', { name: /tasks/i }));
    expect(screen.getByRole('button', { name: /tasks/i })).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);

    expect(screen.getByRole('button', { name: /tasks/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2 of 2 done')).toBeVisible();
  });

  it('starts compact when a completed checklist is restored with a chat', () => {
    render(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);
    expect(screen.getByRole('button', { name: /tasks/i })).toHaveAttribute('aria-expanded', 'false');
  });
});
