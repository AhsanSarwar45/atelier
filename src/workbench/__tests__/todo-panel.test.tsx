import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { TodoPanel } from '@/workbench/chat-tab';
import { checklistForEpic } from '@/workbench/epic-checklist';
import type { Bead } from '@/types';

const active = [
  { id: '1', text: 'Find the cause', status: 'completed' as const },
  { id: '2', text: 'Fix the screen', status: 'in_progress' as const },
];

describe('the live checklist', () => {
  const bead = (id: string, title: string, status: Bead['status'], extra: Partial<Bead> = {}): Bead => ({
    id, title, status, priority: 1, issue_type: 'task', owner: '', created_at: '', updated_at: '', comments: [], ...extra,
  });

  it("reads an epic's rows and statuses from the board", () => {
    const epic = bead('bw-job', 'The job', 'in_progress', { issue_type: 'epic', children: ['bw-job.1', 'bw-job.2', 'bw-job.3'] });
    const board = [
      epic,
      bead('bw-job.1', 'Finished piece', 'closed', { parent_id: epic.id }),
      bead('bw-job.2', 'Current piece', 'in_progress', { parent_id: epic.id }),
      bead('bw-job.3', 'Later piece', 'open', { parent_id: epic.id }),
    ];

    expect(checklistForEpic([{ id: 'provider-row', text: epic.id, status: 'pending' }], board)).toEqual([
      { id: 'bw-job.1', text: 'Finished piece', status: 'completed' },
      { id: 'bw-job.2', text: 'Current piece', status: 'in_progress' },
      { id: 'bw-job.3', text: 'Later piece', status: 'pending' },
    ]);
  });

  it('does not make a checklist for a task or a hand-written plan', () => {
    const board = [bead('bw-task', 'A task', 'in_progress')];
    expect(checklistForEpic([{ id: '1', text: 'bw-task', status: 'in_progress' }], board)).toEqual([]);
    expect(checklistForEpic(active, board)).toEqual([]);
  });

  it('starts as one row on an opened chat and unfolds when asked', () => {
    render(<TodoPanel items={active} />);

    const toggle = screen.getByRole('button', { name: /checklist/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('todo-panel')).toHaveAttribute('data-expanded', 'no');
    expect(screen.getByText('1/2')).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Fix the screen')).toBeVisible();
  });

  it('caps the unfolded list so a long epic scrolls instead of filling the screen', () => {
    render(<TodoPanel items={active} />);
    fireEvent.click(screen.getByRole('button', { name: /checklist/i }));

    const list = document.getElementById('active-checklist-items');
    expect(list?.className).toContain('overflow-y-auto');
    expect(list?.className).toMatch(/max-h-/);
  });

  it('automatically collapses when the last item completes', () => {
    const view = render(<TodoPanel items={active} />);
    fireEvent.click(screen.getByRole('button', { name: /checklist/i }));
    expect(screen.getByRole('button', { name: /checklist/i })).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);

    expect(screen.getByRole('button', { name: /checklist/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2/2')).toBeVisible();
  });

  it('starts compact when a completed checklist is restored with a chat', () => {
    render(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);
    expect(screen.getByRole('button', { name: /checklist/i })).toHaveAttribute('aria-expanded', 'false');
  });
});
