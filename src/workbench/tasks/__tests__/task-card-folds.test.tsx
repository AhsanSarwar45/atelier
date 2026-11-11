import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { TaskCard } from '@/workbench/tasks/task-card';
import type { Task } from '@/workbench/tasks/types';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const plan = { summary: 'Fold the card', steps: ['one'] };

function chatCard(event: string, task: Partial<Task> = {}) {
  render(<ChatWidgetView widget={{ type: 'task', event, task: makeTask({ type: 'general', title: 'Do the thing', plan, ...task }) }} />);
  return screen.getByTestId('task-card');
}

describe('a task card in a chat', () => {
  it.each([
    ['create', {}],
    ['amend', {}],
    ['block', { status: 'blocked' as const, blocked: { cause: 'no key', needed_to_resume: 'a key' } }],
    ['done', { status: 'review' as const, result: { summary: 'ok' } }],
  ])('starts open for %s', (event, task) => {
    expect(chatCard(event, task)).toHaveAttribute('data-state', 'open');
  });

  it.each([
    ['start', { status: 'in_progress' as const }],
    ['unblock', { status: 'in_progress' as const }],
    ['take', { status: 'in_progress' as const }],
    ['cancel', { status: 'cancelled' as const }],
    ['done', { status: 'done' as const, result: { summary: 'ok' } }],
  ])('starts folded for %s', (event, task) => {
    expect(chatCard(event, task)).toHaveAttribute('data-state', 'closed');
    expect(screen.getByText('Do the thing')).toBeInTheDocument();
  });

  it('opens and folds from its header', () => {
    const card = chatCard('start', { status: 'in_progress', title: 'Do the thing' });
    fireEvent.click(screen.getByTestId('task-card-toggle'));
    expect(card).toHaveAttribute('data-state', 'open');
    fireEvent.click(screen.getByTestId('task-card-toggle'));
    expect(card).toHaveAttribute('data-state', 'closed');
  });
});

describe('the Tasks tab detail', () => {
  it('always shows the whole card, with no toggle', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} />);
    expect(screen.queryByTestId('task-card-toggle')).not.toBeInTheDocument();
  });
});
