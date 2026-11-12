/**
 * Selecting cells and pressing Create task (docs/grids.md, "Work on cells"):
 * a row or column name, or All gaps, brings the selection bar; it counts the
 * cells and the claimable ones and lists why the rest cannot be claimed; and
 * Create task makes the task in a new chat or the chat picked, then opens it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GridsView from '@/workbench/grids/grids-view';
import { makeClaimedRowDetail, makeDetail } from '@/workbench/grids/__tests__/fixtures';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';

const get = vi.fn();
const createForCells = vi.fn();
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    grids: { list: vi.fn(), get: (...args: unknown[]) => get(...args), cell: vi.fn(() => new Promise(() => {})), act: vi.fn() },
    tasks: { ...real.tasks, createForCells: (...args: unknown[]) => createForCells(...args) },
  };
});
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', projectId: 'p1', name: 'Chat one' }, { id: 'other', projectId: 'p2', name: 'Elsewhere' }],
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=tasks&view=grids&grid=camera'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

beforeEach(() => {
  get.mockReset().mockResolvedValue(makeDetail());
  createForCells.mockReset().mockResolvedValue({ task: makeTask({ number: 12, sessionId: 'new-chat' }), sessionId: 'new-chat' });
});

function draw(onOpenTask = vi.fn()) {
  const onOpenChat = vi.fn();
  render(<GridsView projectId="p1" grid="camera" cell={null} onShow={vi.fn()} onOpenChat={onOpenChat} onOpenTask={onOpenTask} />);
  return { onOpenChat, onOpenTask };
}

const column = async (id: string) => (await screen.findAllByTestId('grid-column')).find((el) => el.dataset.col === id)!;
const rowName = async (name: string) => (await screen.findAllByTestId('grid-row-name')).find((el) => el.textContent === name)!;

describe('Create task from a grid selection', () => {
  it('shows the bar for a click on a row or column name', async () => {
    draw();
    fireEvent.click(await rowName('Sunstar'));
    let bar = screen.getByTestId('grid-selection');
    expect(within(bar).getByTestId('grid-selection-count').textContent).toBe('2 cells');
    expect(within(bar).getByTestId('grid-create-task').textContent).toBe('Create task · 1 cell');
    fireEvent.click(await column('cpu'));
    bar = screen.getByTestId('grid-selection');
    expect(within(bar).getByTestId('grid-selection-count').textContent).toBe('5 cells');
  });

  it('counts the cells and the claimable ones, and says why the rest cannot be claimed', async () => {
    draw();
    fireEvent.click(await column('gpu'));
    const bar = screen.getByTestId('grid-selection');
    expect(within(bar).getByTestId('grid-selection-count').textContent).toBe('5 cells');
    expect(within(bar).getByTestId('grid-selection-claimable').textContent).toBe('(1 claimable)');
    expect(within(bar).getByTestId('grid-create-task').textContent).toBe('Create task · 1 cell');
    // The column's proof rule, since one column is selected.
    expect(bar.textContent).toContain('Proof for gpu');
    fireEvent.click(within(bar).getByTestId('grid-selection-claimable'));
    const blocked = await screen.findByTestId('grid-selection-blocked');
    expect(blocked.textContent).toContain('sunstar.gpu');
    expect(blocked.textContent).toContain('Claimed by #7');
    expect(blocked.textContent).toContain('Read-only: owned by the colour grid');
  });

  it('makes the task in a new chat and opens it', async () => {
    const { onOpenChat } = draw();
    fireEvent.click(await rowName('Glare'));
    fireEvent.click(screen.getByTestId('grid-create-task'));
    const menu = await screen.findByTestId('create-task-chats');
    // This project's chats only.
    expect(within(menu).getAllByTestId('create-task-chat').map((el) => el.textContent)).toEqual(['Chat one']);
    fireEvent.click(within(menu).getByTestId('create-task-new-chat'));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith('new-chat'));
    expect(createForCells).toHaveBeenCalledWith('p1', { slug: 'camera', rows: ['glare'], cols: '*', onlyGaps: false }, 'new');
    // The grid is read again so its cells show claimed, and the selection goes.
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('grid-selection')).toBeNull();
  });

  it('makes the task in the chat picked', async () => {
    createForCells.mockResolvedValue({ task: makeTask({ number: 13 }), sessionId: 's1' });
    const { onOpenChat } = draw();
    fireEvent.click(await column('cpu'));
    fireEvent.click(screen.getByTestId('grid-create-task'));
    fireEvent.click(await screen.findByTestId('create-task-chat'));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith('s1'));
    expect(createForCells).toHaveBeenCalledWith('p1', { slug: 'camera', rows: '*', cols: ['cpu'], onlyGaps: false }, 's1');
  });

  it("shows the server's refusal in the menu and opens nothing", async () => {
    createForCells.mockRejectedValue(new Error('API error: 400 camera.sunstar.cpu is claimed by #14 in chat "Glare GPU"'));
    const { onOpenChat } = draw();
    fireEvent.click(await column('cpu'));
    fireEvent.click(screen.getByTestId('grid-create-task'));
    fireEvent.click(await screen.findByTestId('create-task-new-chat'));
    const error = await screen.findByTestId('create-task-error');
    expect(error.textContent).toBe('Couldn\'t create task. camera.sunstar.cpu is claimed by #14 in chat "Glare GPU"');
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  it('All gaps selects every gap and makes a task of only those', async () => {
    const { onOpenChat } = draw();
    fireEvent.click(await screen.findByTestId('grid-all-gaps'));
    const bar = screen.getByTestId('grid-selection');
    // sunstar.cpu; glare.old is in a retired column.
    expect(within(bar).getByTestId('grid-selection-count').textContent).toBe('All gaps · 1 cell');
    const outlined = screen.getAllByTestId('grid-cell').filter((el) => el.getAttribute('aria-pressed') === 'true');
    expect(outlined.map((el) => `${el.dataset.row}.${el.dataset.col}`)).toEqual(['sunstar.cpu']);
    fireEvent.click(within(bar).getByTestId('grid-create-task'));
    fireEvent.click(await screen.findByTestId('create-task-new-chat'));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith('new-chat'));
    expect(createForCells).toHaveBeenCalledWith('p1', { slug: 'camera', rows: '*', cols: '*', onlyGaps: true }, 'new');
  });

  it('cannot create a task with nothing claimable', async () => {
    draw();
    const both = (await screen.findAllByTestId('grid-cell')).find((el) => el.dataset.row === 'both' && el.dataset.col === 'gpu')!;
    fireEvent.click(both, { ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-create-task')).toBeDisabled());
    expect(screen.getByTestId('grid-create-task').textContent).toBe('Create task');
  });

  it('offers Create task only for a selection made on purpose, not for opening a cell', async () => {
    const onShow = vi.fn();
    const { rerender } = render(<GridsView projectId="p1" grid="camera" cell={null} onShow={onShow} onOpenChat={vi.fn()} />);
    const glare = (await screen.findAllByTestId('grid-cell')).find((el) => el.dataset.row === 'glare' && el.dataset.col === 'cpu')!;
    fireEvent.click(glare);
    expect(onShow).toHaveBeenLastCalledWith({ grid: 'camera', cell: 'glare:cpu' });
    rerender(<GridsView projectId="p1" grid="camera" cell={{ row: 'glare', col: 'cpu' }} onShow={onShow} onOpenChat={vi.fn()} />);
    // The open cell is outlined, but there is no selection bar.
    const open = (await screen.findAllByTestId('grid-cell')).find((el) => el.dataset.row === 'glare' && el.dataset.col === 'cpu')!;
    expect(open.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('grid-selection')).toBeNull();
    // A column picked on purpose brings it; Clear takes it away and leaves the cell open.
    fireEvent.click(await column('gpu'));
    expect(screen.getByTestId('grid-selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('grid-selection')).toBeNull();
    expect(onShow).not.toHaveBeenCalledWith({ grid: 'camera', cell: null });
  });

  it('links a row one task claims whole to that task', async () => {
    get.mockResolvedValue(makeClaimedRowDetail());
    const { onOpenTask } = draw();
    await screen.findAllByTestId('grid-row-name');
    const claims = screen.getAllByTestId('grid-claim');
    // The glare row only: no column is claimed whole.
    expect(claims.map((el) => el.textContent)).toEqual(['#9']);
    expect(claims[0]!.closest('tr')!.dataset.row).toBe('glare');
    fireEvent.click(claims[0]!);
    expect(onOpenTask).toHaveBeenCalledWith(9);
  });
});
