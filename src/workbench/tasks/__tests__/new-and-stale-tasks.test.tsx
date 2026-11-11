/**
 * The Tasks tab's New task button (bw-bp53q.9) and stale `todo` tasks
 * (bw-bp53q.10).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readUnsentLine, writeUnsentLine } from '@/workbench/drafts';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { checklistForTasks } from '@/workbench/tasks/checklist';
import { NEW_TASK_LINE, takeComposerFocus } from '@/workbench/tasks/new-task';
import { isStale, STALE_AFTER_MS, STALE_REASON } from '@/workbench/tasks/stale';
import TasksTab from '@/workbench/tasks/tasks-tab';

const list = vi.fn();
const act = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    list: (...args: unknown[]) => list(...args),
    get: vi.fn().mockResolvedValue({ task: null, events: [] }),
    act: (...args: unknown[]) => act(...args),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [
    { id: 's1', state: 'idle', cwd: '/repo', name: 'Chat one', projectId: 'p1' },
    { id: 's2', state: 'dormant', cwd: '/repo', name: 'Chat two', projectId: 'p1' },
    { id: 's9', state: 'idle', cwd: '/other', name: 'Elsewhere', projectId: 'p2' },
  ],
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const tasks = [
  makeTask({ number: 1, title: 'Fresh todo', status: 'todo', updatedAt: now - DAY }),
  makeTask({ number: 2, title: 'Old todo', status: 'todo', updatedAt: now - 15 * DAY }),
  makeTask({ number: 3, title: 'Old work', status: 'in_progress', updatedAt: now - 30 * DAY }),
];

beforeEach(() => {
  list.mockReset().mockResolvedValue(tasks);
  act.mockReset();
  writeUnsentLine('s1', '');
});

describe('a stale task', () => {
  it('is a todo untouched for more than 14 days', () => {
    expect(STALE_AFTER_MS).toBe(14 * DAY);
    expect(isStale({ status: 'todo', updatedAt: now - 14 * DAY - 1 }, now)).toBe(true);
    expect(isStale({ status: 'todo', updatedAt: now - 14 * DAY }, now)).toBe(false);
    expect(isStale({ status: 'in_progress', updatedAt: 0 }, now)).toBe(false);
    expect(isStale({ status: 'blocked', updatedAt: 0 }, now)).toBe(false);
  });

  it('is marked in the chat checklist', () => {
    const items = checklistForTasks(tasks, 's1', 'idle', now);
    expect(items.map((item) => [item.id, item.stale ?? false])).toEqual([['1', false], ['2', true], ['3', false]]);
  });

  it('is marked on its row, counted on its group, and cancelled with the stale reason', async () => {
    act.mockResolvedValue({ task: { ...tasks[1], status: 'cancelled' }, widget: null });
    render(<TasksTab projectId="p1" />);
    const old = (await screen.findByText('Old todo')).closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(old).getByTestId('task-row-stale')).toHaveTextContent('Stale');
    const fresh = screen.getByText('Fresh todo').closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(fresh).queryByTestId('task-row-stale')).toBeNull();
    expect(screen.getAllByTestId('task-row-cancel')).toHaveLength(1);
    expect(screen.getByTestId('task-group-stale')).toHaveTextContent('1 stale');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel task #2' }));
    expect(await screen.findByRole('textbox', { name: 'Reason' })).toHaveValue(STALE_REASON);
    expect(STALE_REASON).toBe('Stale: not touched for 14 days');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 2, 'cancel', { reason: STALE_REASON }));
    // The row's own click was not taken for a pick.
    expect(screen.queryByTestId('task-detail')).toBeNull();
  });
});

describe('the New task button', () => {
  it("offers this project's chats and a new one", async () => {
    render(<TasksTab projectId="p1" onOpenChat={() => {}} onNewChat={() => {}} />);
    fireEvent.click(await screen.findByTestId('new-task'));
    const menu = await screen.findByTestId('new-task-chats');
    expect(within(menu).getAllByTestId('new-task-chat').map((row) => row.textContent)).toEqual(['Chat one', 'Chat two']);
    expect(within(menu).getByTestId('new-task-new-chat')).toHaveTextContent('New chat');
  });

  it('opens the chat picked with `@task ` in its composer, focused', async () => {
    writeUnsentLine('s1', 'half a thought');
    const onOpenChat = vi.fn();
    render(<TasksTab projectId="p1" onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByTestId('new-task'));
    fireEvent.click(within(await screen.findByTestId('new-task-chats')).getByText('Chat one'));
    expect(onOpenChat).toHaveBeenCalledWith('s1');
    expect(readUnsentLine('s1')).toBe(`half a thought\n${NEW_TASK_LINE}`);
    expect(takeComposerFocus('s2')).toBe(false);
    expect(takeComposerFocus('s1')).toBe(true);
    expect(takeComposerFocus('s1')).toBe(false);
  });

  it('asks for a new chat', async () => {
    const onNewChat = vi.fn();
    render(<TasksTab projectId="p1" onOpenChat={() => {}} onNewChat={onNewChat} />);
    fireEvent.click(await screen.findByTestId('new-task'));
    fireEvent.click(await screen.findByTestId('new-task-new-chat'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
