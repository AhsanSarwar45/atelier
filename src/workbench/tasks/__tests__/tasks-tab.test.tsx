import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import TasksTab, { filterTasks, groupTasks } from '@/workbench/tasks/tasks-tab';
import { tasksChangedFor } from '@/workbench/tasks/use-tasks';

const list = vi.fn();
const get = vi.fn();
const act = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
    act: (...args: unknown[]) => act(...args),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [
    { id: 's1', state: 'idle', cwd: '/repo', name: 'Chat one' },
    { id: 's2', state: 'dormant', cwd: '/repo', name: 'Chat two' },
  ],
}));
const feed: Array<{ frame: (data: string) => void }> = [];
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: (listener: { frame: (data: string) => void }) => {
    feed.push(listener);
    return () => { feed.splice(feed.indexOf(listener), 1); };
  },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const tasks = [
  makeTask({ number: 1, title: 'Old work', status: 'done', sessionId: 's1' }),
  makeTask({ number: 2, title: 'Current work', status: 'in_progress', sessionId: 's1' }),
  makeTask({ number: 3, title: 'Asleep work', status: 'in_progress', sessionId: 's2', sessionTitle: 'Chat two' }),
  makeTask({ number: 4, title: 'Loose work', status: 'todo', sessionId: null, sessionTitle: null }),
  makeTask({ number: 5, title: 'Dropped work', status: 'cancelled', sessionId: 's1' }),
  makeTask({ number: 6, title: 'Look at this', status: 'review', sessionId: 's1', type: 'plan', plan: { question: 'Q', scope: 'S', constraints: [] } }),
  makeTask({ number: 7, title: 'Stuck work', status: 'blocked', sessionId: 's2', blocked: { cause: 'CI', needed_to_resume: 'CI up' } }),
];

beforeEach(() => {
  list.mockReset().mockResolvedValue(tasks);
  get.mockReset().mockResolvedValue({ task: tasks[1], events: [
    { seq: 1, at: 1_700_000_000_000, kind: 'created', sessionId: 's1', actor: 'agent', payload: null },
    { seq: 2, at: 1_700_000_100_000, kind: 'reopened', sessionId: 's1', actor: 'owner', payload: { note: 'Try again' } },
  ] });
  act.mockReset();
  feed.length = 0;
});

describe('task grouping and filtering', () => {
  it('groups by status in the fixed order, newest first, leaving empty groups out', () => {
    const groups = groupTasks(tasks);
    expect(groups.map((g) => g.label)).toEqual(['In progress', 'In review', 'Blocked', 'Todo', 'Done', 'Cancelled']);
    expect(groups[0]!.tasks.map((t) => t.number)).toEqual([3, 2]);
    expect(groupTasks([tasks[3]!]).map((g) => g.status)).toEqual(['todo']);
  });

  it('filters to one chat or to unassigned tasks', () => {
    expect(filterTasks(tasks, 'all')).toHaveLength(7);
    expect(filterTasks(tasks, 'unassigned').map((t) => t.number)).toEqual([4]);
    expect(filterTasks(tasks, { session: 's2' }).map((t) => t.number)).toEqual([3, 7]);
  });

  it("reads only this project's change frames", () => {
    expect(tasksChangedFor(JSON.stringify({ type: 'tasks.changed', projectId: 'p1', number: 2 }), 'p1')).toBe(true);
    expect(tasksChangedFor(JSON.stringify({ kind: 'tasks.changed', projectId: 'p1' }), 'p1')).toBe(true);
    expect(tasksChangedFor(JSON.stringify({ type: 'tasks.changed', projectId: 'p2' }), 'p1')).toBe(false);
    expect(tasksChangedFor('{"kind":"running","holds":[]}', 'p1')).toBe(false);
  });
});

describe('the Tasks tab', () => {
  it('lists tasks by status with finished groups folded', async () => {
    render(<TasksTab projectId="p1" />);
    await waitFor(() => expect(screen.getAllByTestId('task-group')).toHaveLength(6));
    expect(list).toHaveBeenCalledWith('p1', undefined);
    const group = (status: string) => screen.getAllByTestId('task-group').find((g) => g.getAttribute('data-status') === status)!;
    expect(within(group('in_progress')).getAllByTestId('task-row').map((r) => r.getAttribute('data-number'))).toEqual(['3', '2']);
    expect(within(group('done')).queryByTestId('task-row')).toBeNull();
    expect(within(group('cancelled')).queryByTestId('task-row')).toBeNull();
    fireEvent.click(within(group('done')).getByRole('button', { name: /Done/ }));
    expect(within(group('done')).getByText('Old work')).toBeVisible();
  });

  it('shows each row with its number, type, chat and status, paused when the chat is not running', async () => {
    render(<TasksTab projectId="p1" />);
    const row = await screen.findByText('Asleep work');
    const line = row.closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(line).getByText('#3')).toBeVisible();
    expect(within(line).getByText('Feature')).toBeVisible();
    expect(within(line).getByText('Chat two')).toBeInTheDocument();
    expect(within(line).getByTestId('task-status')).toHaveAttribute('data-status', 'paused');
    const loose = screen.getByText('Loose work').closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(loose).getByText('Unassigned')).toBeInTheDocument();
  });

  it('opens a detail panel with the card, its history and the owner actions', async () => {
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Current work'));
    const detail = await screen.findByTestId('task-detail');
    expect(within(detail).getByTestId('task-card')).toHaveAttribute('data-task-status', 'in_progress');
    await waitFor(() => expect(within(detail).getByTestId('task-history')).toHaveTextContent('Try again'));
    expect(get).toHaveBeenCalledWith('p1', 2);
    expect(within(detail).getByRole('button', { name: 'Release' })).toBeVisible();
    expect(within(detail).getByRole('button', { name: 'Cancel task' })).toBeVisible();
  });

  it('cancels a task with a reason', async () => {
    act.mockResolvedValue({ task: { ...tasks[1], status: 'cancelled' }, widget: null });
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Current work'));
    const detail = await screen.findByTestId('task-detail');
    fireEvent.click(within(detail).getByRole('button', { name: 'Cancel task' }));
    fireEvent.change(within(detail).getByRole('textbox', { name: 'Reason' }), { target: { value: 'Not needed' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 2, 'cancel', { reason: 'Not needed' }));
  });

  it('offers approve and reopen on a task in review', async () => {
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Look at this'));
    const detail = await screen.findByTestId('task-detail');
    expect(within(detail).getByRole('button', { name: 'Approve' })).toBeVisible();
    expect(within(detail).getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  it('shows the chosen task after an owner action on another one', async () => {
    act.mockResolvedValue({ task: { ...tasks[5], status: 'done', updatedAt: 99 }, widget: null });
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Look at this'));
    let detail = await screen.findByTestId('task-detail');
    fireEvent.click(within(detail).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(detail).getByTestId('task-card')).toHaveAttribute('data-task-status', 'done'));
    fireEvent.click(screen.getByText('Current work'));
    detail = await screen.findByTestId('task-detail');
    expect(within(detail).getByText('Task #2')).toBeVisible();
    expect(within(detail).getByTestId('task-card')).toHaveAttribute('data-task-status', 'in_progress');
    expect(within(detail).getByRole('heading', { name: 'Current work' })).toBeVisible();
  });

  it('starts a cancel form afresh when another task is chosen', async () => {
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Current work'));
    let detail = await screen.findByTestId('task-detail');
    fireEvent.click(within(detail).getByRole('button', { name: 'Cancel task' }));
    expect(within(detail).getByRole('textbox', { name: 'Reason' })).toBeVisible();
    fireEvent.click(screen.getByText('Loose work'));
    detail = await screen.findByTestId('task-detail');
    expect(within(detail).queryByRole('textbox', { name: 'Reason' })).toBeNull();
  });

  it('marks a row whose plan change waits for the owner, and one finished with shortfalls', async () => {
    list.mockResolvedValue([
      makeTask({ number: 1, title: 'Amended', status: 'in_progress', pendingAmend: { outcome: 'x', criteria: [] } }),
      makeTask({ number: 2, title: 'Short', status: 'done', shortfalls: true }),
    ]);
    render(<TasksTab projectId="p1" />);
    const amended = (await screen.findByText('Amended')).closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(amended).getByTestId('task-row-amend')).toHaveTextContent('Plan change');
    expect(within(amended).queryByTestId('task-row-shortfalls')).toBeNull();
    const group = screen.getAllByTestId('task-group').find((g) => g.getAttribute('data-status') === 'done')!;
    fireEvent.click(within(group).getByRole('button', { name: /Done/ }));
    const short = within(group).getByText('Short').closest('[data-testid="task-row"]') as HTMLElement;
    expect(within(short).getByRole('img', { name: 'Finished with shortfalls' })).toBeInTheDocument();
  });

  it('reads the list again when the feed says the tasks changed', async () => {
    render(<TasksTab projectId="p1" />);
    await screen.findByText('Current work');
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue([...tasks, makeTask({ number: 8, title: 'Brand new', status: 'todo' })]);
    feed.forEach((l) => l.frame(JSON.stringify({ type: 'tasks.changed', projectId: 'p1', number: 8 })));
    expect(await screen.findByText('Brand new')).toBeVisible();
    feed.forEach((l) => l.frame(JSON.stringify({ type: 'tasks.changed', projectId: 'other', number: 1 })));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('says so when there are no tasks', async () => {
    list.mockResolvedValue([]);
    render(<TasksTab projectId="p1" />);
    expect(await screen.findByText('No tasks yet')).toBeVisible();
  });
});
