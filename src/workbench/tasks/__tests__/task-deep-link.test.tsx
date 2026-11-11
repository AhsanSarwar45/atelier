/**
 * `?tab=tasks&task=N` is the open task (bw-bp53q.6): the address picks the
 * row, picking a row writes the address, and a `@task:N` badge goes there.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReferenceBadge } from '@/components/reference-badge';
import { addressWith, showTask, whereFrom } from '@/lib/address';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import TasksTab from '@/workbench/tasks/tasks-tab';

const list = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
    act: vi.fn(),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat&chat=s1'),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const tasks = [
  makeTask({ number: 2, title: 'Second', status: 'in_progress', updatedAt: Date.now() }),
  makeTask({ number: 3, title: 'Third', status: 'todo', updatedAt: Date.now() }),
];

beforeEach(() => {
  list.mockReset().mockResolvedValue(tasks);
  get.mockReset().mockResolvedValue({ task: tasks[0], events: [] });
  push.mockReset();
});

describe('the task in the address', () => {
  it('reads `task` as a number and writes it back, or drops it', () => {
    expect(whereFrom(new URLSearchParams('id=p1&tab=tasks&task=7')).task).toBe(7);
    expect(whereFrom(new URLSearchParams('id=p1&tab=tasks&task=x')).task).toBeNull();
    const params = new URLSearchParams('id=p1&tab=tasks');
    expect(addressWith(params, { task: 4 })).toBe('/project?id=p1&tab=tasks&task=4');
    expect(addressWith(new URLSearchParams('id=p1&tab=tasks&task=4'), { task: null })).toBe('/project?id=p1&tab=tasks');
  });

  it('is rewritten in place, so picking tasks adds no history', () => {
    window.history.replaceState(null, '', '/project?id=p1&tab=tasks');
    const before = window.history.length;
    showTask(new URLSearchParams(window.location.search), 5);
    expect(window.location.search).toBe('?id=p1&tab=tasks&task=5');
    showTask(new URLSearchParams(window.location.search), null);
    expect(window.location.search).toBe('?id=p1&tab=tasks');
    expect(window.history.length).toBe(before);
  });

  it('hands Next no entry state of its own, so the screen follows the change', () => {
    // Next's history integration skips a replace whose state carries its own
    // `__NA` mark: `useSearchParams` would keep the old address and the detail
    // would never open.
    window.history.replaceState({ __NA: true }, '', '/project?id=p1&tab=tasks');
    const replace = vi.spyOn(window.history, 'replaceState');
    showTask(new URLSearchParams(window.location.search), 5);
    expect(replace).toHaveBeenLastCalledWith(null, '', '/project?id=p1&tab=tasks&task=5');
    replace.mockRestore();
  });
});

describe('the Tasks tab told which task is open', () => {
  it('opens the detail of the task the address names', async () => {
    render(<TasksTab projectId="p1" selected={2} onSelect={() => {}} />);
    const detail = await screen.findByTestId('task-detail');
    expect(within(detail).getByText('Task #2')).toBeVisible();
  });

  it('asks for a picked task, and for none when the detail is closed', async () => {
    const onSelect = vi.fn();
    render(<TasksTab projectId="p1" selected={2} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('Third'));
    expect(onSelect).toHaveBeenLastCalledWith(3);
    fireEvent.click(within(screen.getByTestId('task-detail')).getByRole('button', { name: 'Close' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('unfolds the folded group that holds it, so its row shows too', async () => {
    list.mockResolvedValue([...tasks, makeTask({ number: 4, title: 'Fourth', status: 'done', updatedAt: Date.now() })]);
    render(<TasksTab projectId="p1" selected={4} onSelect={() => {}} />);
    await screen.findByTestId('task-detail');
    const done = screen.getAllByTestId('task-group').find((group) => group.dataset.status === 'done')!;
    expect(within(done).getByText('Fourth')).toBeVisible();
  });

  it('follows the address when Back or Forward changes it', async () => {
    const { rerender } = render(<TasksTab projectId="p1" selected={2} onSelect={() => {}} />);
    await screen.findByTestId('task-detail');
    rerender(<TasksTab projectId="p1" selected={3} onSelect={() => {}} />);
    expect(within(screen.getByTestId('task-detail')).getByText('Task #3')).toBeVisible();
    rerender(<TasksTab projectId="p1" selected={null} onSelect={() => {}} />);
    expect(screen.queryByTestId('task-detail')).toBeNull();
  });
});

describe('a @task:N badge', () => {
  it('opens that task in the Tasks tab', () => {
    render(<ReferenceBadge reference={{ kind: 'task', id: '12', title: 'Fix it', status: 'todo' }} projectId="p1" testId="badge" />);
    fireEvent.click(screen.getByTestId('badge'));
    expect(push).toHaveBeenCalledWith('/project?id=p1&tab=tasks&chat=s1&task=12');
  });
});
