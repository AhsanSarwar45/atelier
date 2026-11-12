/**
 * A task whose cells are one whole row, column or grid says so in one line
 * (`Glare row · 5 cells`) on its card, its chat card and its Tasks row,
 * rather than listing each cell (docs/grids.md, "Claims").
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { claimShapeLabel } from '@/workbench/grids/task-cells';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { TaskCard } from '@/workbench/tasks/task-card';
import TasksTab from '@/workbench/tasks/tasks-tab';
import type { ClaimShape, Task, TaskCell } from '@/workbench/tasks/types';

const list = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { list: (...args: unknown[]) => list(...args), get: vi.fn(() => new Promise(() => {})), act: vi.fn() },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo', name: 'Chat one' }],
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

const glare: ClaimShape = { grid: 'camera', kind: 'row', id: 'glare', name: 'Glare', count: 5 };
const cells: TaskCell[] = ['cpu', 'gpu', 'perf', 'docs', 'truth'].map((col, i) => ({
  grid: 'camera', row: 'glare', col, state: i === 0 ? 'proved' : 'in_progress', claimed: true, reason: null,
}));
const claiming = (over: Partial<Task> = {}) => makeTask({ number: 14, title: 'Cover glare', cells, claimShape: glare, ...over });

beforeEach(() => list.mockReset());

describe('a claim shape', () => {
  it('reads as the row, column or grid and its count', () => {
    expect(claimShapeLabel(glare)).toBe('Glare row · 5 cells');
    expect(claimShapeLabel({ grid: 'camera', kind: 'col', id: 'truth', name: 'Ground-truth tests', count: 4 })).toBe('Ground-truth tests column · 4 cells');
    expect(claimShapeLabel({ grid: 'camera', kind: 'grid', id: 'camera', name: 'Renderer camera', count: 1 })).toBe('Renderer camera grid · 1 cell');
  });

  it('stands for the cells on the task card, with how many are in each state', () => {
    render(<TaskCard task={claiming()} />);
    const section = screen.getByTestId('task-cells');
    expect(within(section).getByTestId('task-claim-shape').textContent).toBe('Glare row · 5 cells');
    expect(within(section).getByTestId('task-claim-states').textContent).toBe('1 proved · 4 in progress');
    expect(within(section).queryAllByTestId('task-cell')).toHaveLength(0);
  });

  it('lists each cell when they make no one shape', () => {
    render(<TaskCard task={claiming({ claimShape: null })} />);
    expect(screen.queryByTestId('task-claim-shape')).toBeNull();
    expect(screen.getAllByTestId('task-cell')).toHaveLength(5);
  });

  it('is on the chat card', () => {
    render(<ChatWidgetView widget={{ type: 'task', event: 'create', task: claiming() }} />);
    expect(within(screen.getByTestId('task-card')).getByTestId('task-claim-shape').textContent).toBe('Glare row · 5 cells');
  });

  it('is on the Tasks row', async () => {
    list.mockResolvedValue([claiming(), makeTask({ number: 15, title: 'Loose work' })]);
    render(<TasksTab projectId="p1" />);
    const rows = await screen.findAllByTestId('task-row');
    const row = rows.find((el) => el.dataset.number === '14')!;
    expect(within(row).getByTestId('task-row-shape').textContent).toBe('Glare row · 5 cells');
    expect(within(rows.find((el) => el.dataset.number === '15')!).queryByTestId('task-row-shape')).toBeNull();
  });
});
