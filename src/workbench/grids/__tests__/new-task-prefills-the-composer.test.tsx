/**
 * Selecting cells and pressing New task (docs/grids.md, "Selection"): the bar
 * counts the cells and the claimable ones, lists why the rest cannot be
 * claimed, and New task writes `@task @grid:SLUG.ROWS.COLS ` into the chat
 * picked, or into the new chat New chat starts.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readUnsentLine, writeUnsentLine } from '@/workbench/drafts';
import GridsView from '@/workbench/grids/grids-view';
import { makeDetail } from '@/workbench/grids/__tests__/fixtures';
import { takeNewChatLine } from '@/workbench/tasks/new-task';

const get = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: { list: vi.fn(), get: (...args: unknown[]) => get(...args), cell: vi.fn(() => new Promise(() => {})), act: vi.fn() },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', projectId: 'p1', name: 'Chat one' }],
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
  writeUnsentLine('s1', '');
});

function draw() {
  const onOpenChat = vi.fn();
  const onNewChat = vi.fn();
  render(<GridsView projectId="p1" grid="camera" cell={null} onShow={vi.fn()} onOpenChat={onOpenChat} onNewChat={onNewChat} />);
  return { onOpenChat, onNewChat };
}

describe('New task from a grid selection', () => {
  it('counts the cells and the claimable ones, and says why the rest cannot be claimed', async () => {
    draw();
    const gpu = (await screen.findAllByTestId('grid-column')).find((el) => el.dataset.col === 'gpu')!;
    fireEvent.click(gpu);
    const bar = screen.getByTestId('grid-selection');
    expect(within(bar).getByTestId('grid-selection-count').textContent).toBe('5 cells');
    expect(within(bar).getByTestId('grid-selection-claimable').textContent).toBe('(1 claimable)');
    // The column's proof rule, since one column is selected.
    expect(bar.textContent).toContain('Proof for gpu');
    fireEvent.click(within(bar).getByTestId('grid-selection-claimable'));
    const blocked = await screen.findByTestId('grid-selection-blocked');
    expect(blocked.textContent).toContain('sunstar.gpu');
    expect(blocked.textContent).toContain('Claimed by #7');
    expect(blocked.textContent).toContain('Read-only: owned by the colour grid');
  });

  it('writes @task and the selection into the chat picked, and opens it', async () => {
    const { onOpenChat } = draw();
    const gpu = (await screen.findAllByTestId('grid-column')).find((el) => el.dataset.col === 'gpu')!;
    fireEvent.click(gpu);
    fireEvent.click(screen.getByTestId('grid-new-task'));
    fireEvent.click(await screen.findByTestId('new-task-chat'));
    expect(readUnsentLine('s1')).toBe('@task @grid:camera.*.gpu ');
    expect(onOpenChat).toHaveBeenCalledWith('s1');
  });

  it('hands the line to the chat New chat starts', async () => {
    const { onNewChat } = draw();
    const glare = (await screen.findAllByTestId('grid-row-name'))[0]!;
    fireEvent.click(glare);
    fireEvent.click(screen.getByTestId('grid-new-task'));
    fireEvent.click(await screen.findByTestId('new-task-new-chat'));
    expect(onNewChat).toHaveBeenCalled();
    expect(takeNewChatLine()).toBe('@task @grid:camera.glare.* ');
    // Read once: the next New chat gets the plain line again.
    expect(takeNewChatLine()).toBe('@task ');
  });

  it('cannot start a task with nothing claimable', async () => {
    draw();
    const both = (await screen.findAllByTestId('grid-cell')).find((el) => el.dataset.row === 'both' && el.dataset.col === 'gpu')!;
    fireEvent.click(both, { ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('grid-new-task')).toBeDisabled());
  });

  it('offers New task only for a selection made on purpose, not for opening a cell', async () => {
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
    fireEvent.click((await screen.findAllByTestId('grid-column')).find((el) => el.dataset.col === 'gpu')!);
    expect(screen.getByTestId('grid-selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('grid-selection')).toBeNull();
    expect(onShow).not.toHaveBeenCalledWith({ grid: 'camera', cell: null });
  });
});
