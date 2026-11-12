/**
 * `?tab=tasks&view=grids&grid=SLUG&cell=ROW:COL` (docs/grids.md, "Front end"):
 * the address opens the Grids view, the grid and the cell's detail; picking
 * rewrites it in place; an `@grid:` badge goes there.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gridBadge, ReferenceBadge } from '@/components/reference-badge';
import { addressWith, cellFrom, showGrids, whereFrom } from '@/lib/address';
import { makeCellDetail, makeDetail } from '@/workbench/grids/__tests__/fixtures';
import TasksTab from '@/workbench/tasks/tasks-tab';

const get = vi.fn();
const cell = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { list: vi.fn(async () => []), get: vi.fn(), act: vi.fn() },
  grids: { list: vi.fn(), get: (...args: unknown[]) => get(...args), cell: (...args: unknown[]) => cell(...args), act: vi.fn() },
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

beforeEach(() => {
  get.mockReset().mockResolvedValue(makeDetail());
  cell.mockReset().mockResolvedValue(makeCellDetail());
  push.mockReset();
});

describe('the grid and cell in the address', () => {
  it('reads the view, the grid and the cell', () => {
    const where = whereFrom(new URLSearchParams('id=p1&tab=tasks&view=grids&grid=camera&cell=glare:gpu'));
    expect([where.view, where.grid, where.cell]).toEqual(['grids', 'camera', 'glare:gpu']);
    expect(cellFrom(where.cell)).toEqual({ row: 'glare', col: 'gpu' });
    expect(cellFrom('glare')).toBeNull();
    expect(cellFrom('a:b:c')).toBeNull();
    // A grid named without the view still asks for the grids.
    expect(whereFrom(new URLSearchParams('id=p1&tab=tasks&grid=camera')).view).toBe('grids');
    expect(whereFrom(new URLSearchParams('id=p1&tab=tasks')).view).toBe('tasks');
  });

  it('is rewritten in place, and going back to tasks drops the grid', () => {
    window.history.replaceState(null, '', '/project?id=p1&tab=tasks');
    const before = window.history.length;
    showGrids(new URLSearchParams(window.location.search), { grid: 'camera', cell: 'glare:gpu' });
    expect(window.location.search).toBe('?id=p1&tab=tasks&view=grids&grid=camera&cell=glare%3Agpu');
    showGrids(new URLSearchParams(window.location.search), { view: 'tasks' });
    expect(window.location.search).toBe('?id=p1&tab=tasks');
    expect(window.history.length).toBe(before);
  });

  it('opens the grid with the cell detail beside it', async () => {
    render(<TasksTab projectId="p1" view="grids" grid="camera" cell="glare:gpu" onShowGrid={vi.fn()} />);
    expect(await screen.findByTestId('grid-view')).toBeTruthy();
    const detail = await screen.findByTestId('cell-detail');
    expect([detail.dataset.row, detail.dataset.col]).toEqual(['glare', 'gpu']);
    await waitFor(() => expect(cell).toHaveBeenCalledWith('p1', 'camera', 'glare', 'gpu'));
    // The cell named is selected too.
    const glareGpu = (await screen.findAllByTestId('grid-cell')).find((el) => el.dataset.row === 'glare' && el.dataset.col === 'gpu')!;
    expect(glareGpu.getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for the cell clicked, and for the owner grid for a reference row', async () => {
    const onShowGrid = vi.fn();
    render(<TasksTab projectId="p1" view="grids" grid="camera" cell={null} onShowGrid={onShowGrid} />);
    const cells = await screen.findAllByTestId('grid-cell');
    fireEvent.click(cells.find((el) => el.dataset.row === 'sunstar' && el.dataset.col === 'cpu')!);
    expect(onShowGrid).toHaveBeenLastCalledWith({ grid: 'camera', cell: 'sunstar:cpu' });
    fireEvent.click(cells.find((el) => el.dataset.row === 'tonemap' && el.dataset.col === 'gpu')!);
    expect(onShowGrid).toHaveBeenLastCalledWith({ grid: 'colour', cell: 'tonemap:gpu' });
  });

  it('switches between Tasks and Grids', async () => {
    const onView = vi.fn();
    render(<TasksTab projectId="p1" view="tasks" onView={onView} />);
    fireEvent.mouseDown(screen.getByTestId('tasks-view-grids'));
    fireEvent.click(screen.getByTestId('tasks-view-grids'));
    expect(onView).toHaveBeenCalledWith('grids');
  });

  it('is where an @grid: badge for one cell goes', () => {
    render(<ReferenceBadge reference={gridBadge('camera.glare.gpu', 'Renderer camera')} projectId="p1" />);
    const badge = screen.getByTestId('reference-badge');
    expect(badge.textContent).toBe('Renderer camera · glare × gpu');
    fireEvent.click(badge);
    expect(push).toHaveBeenCalledWith(addressWith(new URLSearchParams('id=p1&tab=chat&chat=s1'), {
      id: 'p1', tab: 'tasks', task: null, view: 'grids', grid: 'camera', cell: 'glare:gpu',
    }));
    expect(push.mock.calls[0]![0]).toContain('view=grids');
  });
});
