import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { LiveTasksContext, byNumber } from '@/workbench/tasks/use-tasks';

const act = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { act: (...args: unknown[]) => act(...args), list: vi.fn(async () => []), get: vi.fn() },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo' }],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

beforeEach(() => act.mockReset());

const before = { outcome: 'Chats export', criteria: [{ id: 'md', text: 'Exports markdown' }, { id: 'img', text: 'Exports images' }] };
const after = { outcome: 'Chats export', criteria: [{ id: 'md', text: 'Exports markdown' }] };

describe('a plan change the agent made', () => {
  it('applies without waiting, says what it may weaken, and the owner can undo it', async () => {
    const task = makeTask({ status: 'in_progress', plan: after, pendingAmend: null, updatedAt: 3 });
    act.mockResolvedValue({ task: makeTask({ ...task, plan: before, updatedAt: 5 }), widget: null });
    render(<ChatWidgetView widget={{
      type: 'task', event: 'amend', task,
      detail: { previous: before, reason: 'Images moved to another task', weakens: ['removes item “Exports images”'] },
    }} />);
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Plan changed: −1 criterion “Exports images”');
    expect(screen.getByTestId('task-event')).toHaveAttribute('data-waiting', 'no');
    expect(screen.queryByRole('button', { name: 'Approve change' })).toBeNull();
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(screen.getByTestId('task-amend-diff')).toBeVisible();
    expect(screen.getByTestId('task-amend-weakens')).toHaveTextContent('removes item “Exports images”');
    fireEvent.click(screen.getByRole('button', { name: 'Undo change' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 1, 'undo_amend', undefined));
    await waitFor(() => expect(screen.getByTestId('task-event-answer')).toHaveTextContent('Undone'));
    expect(screen.queryByRole('button', { name: 'Undo change' })).toBeNull();
  });

  it('offers no undo once a later change replaced it', () => {
    const printed = makeTask({ status: 'in_progress', plan: after, updatedAt: 3 });
    const now = makeTask({ ...printed, plan: { ...after, outcome: 'Chats export, faster' }, updatedAt: 4 });
    render(
      <LiveTasksContext.Provider value={byNumber([now])}>
        <ChatWidgetView widget={{ type: 'task', event: 'amend', task: printed, detail: { previous: before } }} />
      </LiveTasksContext.Provider>,
    );
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Plan changed');
    expect(screen.queryByRole('button', { name: 'Undo change' })).toBeNull();
  });
});
