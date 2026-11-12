/**
 * A cell's detail (docs/grids.md, "Cell detail"): its state, its proof with
 * each check's last result, benchmarks against their budgets, tests and
 * commits with Merged, its history, and the owner's buttons.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CellDetailPanel } from '@/workbench/grids/cell-detail';
import { makeCellDetail } from '@/workbench/grids/__tests__/fixtures';

const cell = vi.fn();
const act = vi.fn();
const createForCells = vi.fn();
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    grids: { list: vi.fn(), get: vi.fn(), cell: (...args: unknown[]) => cell(...args), act: (...args: unknown[]) => act(...args) },
    tasks: { ...real.tasks, createForCells: (...args: unknown[]) => createForCells(...args) },
  };
});
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', projectId: 'p1', name: 'Chat one' }],
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));

beforeEach(() => {
  cell.mockReset().mockResolvedValue(makeCellDetail());
  act.mockReset().mockResolvedValue({ summary: 'ok' });
});

const draw = (onOpenTask = vi.fn()) => {
  render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" onClose={vi.fn()} onOpenTask={onOpenTask} />);
  return { onOpenTask };
};

describe('the cell detail', () => {
  it('heads with the way back to the grid, by name, for a phone', async () => {
    const onClose = vi.fn();
    render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" gridName="Renderer camera" onClose={onClose} />);
    const back = screen.getByTestId('cell-back');
    expect(back.textContent).toBe('Renderer camera');
    // Shown below md, where the cell takes the grid's place; the close button is the desktop's.
    expect(back.className).toContain('md:hidden');
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('md:inline-flex');
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
    await screen.findByTestId('cell-proof');
  });

  it('shows the proof: summary, checks with their last result, benchmarks, tests and merged commits', async () => {
    draw();
    const proof = await screen.findByTestId('cell-proof');
    expect(cell).toHaveBeenCalledWith('p1', 'camera', 'glare', 'gpu');
    expect(screen.getByTestId('cell-state').dataset.state).toBe('proved');
    expect(proof.textContent).toContain('Glare kernel matches the reference renderer');
    const check = within(proof).getByTestId('cell-check');
    expect(check.dataset.passed).toBe('yes');
    expect(check.textContent).toContain('glare ground truth');
    const benchmarks = within(proof).getByTestId('cell-benchmarks');
    expect(benchmarks.textContent).toContain('glare pass');
    expect(benchmarks.textContent).toContain('0.8');
    expect(proof.textContent).toContain('glare_matches_reference');
    expect(proof.textContent).toContain('abc1234');
    expect(within(proof).getByTestId('cell-merged').dataset.merged).toBe('yes');
    expect(proof.textContent).toContain('shots/glare.png');
  });

  it('shows the history, one line per event', async () => {
    draw();
    const history = await screen.findByTestId('cell-history');
    expect(history.querySelectorAll('li')).toHaveLength(2);
  });

  it('re-checks and reopens a proved cell, with a reason', async () => {
    draw();
    fireEvent.click(await screen.findByTestId('cell-recheck'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('verify', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, undefined));
    await waitFor(() => expect(screen.getByTestId('cell-reopen')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cell-reopen'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'The fix was reverted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('reopen', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, { reason: 'The fix was reverted' }));
  });

  it('offers Approve N/A and Reject with a note while N/A waits on the owner', async () => {
    cell.mockResolvedValue(makeCellDetail({ state: 'na_pending', reason: 'No CPU path for glare', proof: null, lastCheck: null }));
    draw();
    expect((await screen.findByTestId('cell-reason')).textContent).toBe('No CPU path for glare');
    expect(screen.queryByTestId('cell-recheck')).toBeNull();
    expect(screen.queryByTestId('cell-reopen')).toBeNull();
    fireEvent.click(screen.getByTestId('cell-approve-na'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('approve_na', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, undefined));
    await waitFor(() => expect(screen.getByTestId('cell-reject-na')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('cell-reject-na'));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'The CPU path ships' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('reject_na', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, { note: 'The CPU path ships' }));
  });

  it('links the task that claims it, with the chat holding it', async () => {
    cell.mockResolvedValue(makeCellDetail({ state: 'in_progress', claimedTask: 7, claimedChat: { id: 's2', title: 'Glare fixes' }, proof: null, lastCheck: null }));
    const { onOpenTask } = draw();
    const claimed = await screen.findByTestId('cell-claimed');
    expect(claimed.textContent).toBe('Task #7 · Glare fixes');
    fireEvent.click(claimed);
    expect(onOpenTask).toHaveBeenCalledWith(7);
    // A claimed cell is not offered to another task.
    expect(screen.queryByTestId('cell-create-task')).toBeNull();
  });

  it('names the task alone when the server does not say which chat holds it', async () => {
    cell.mockResolvedValue(makeCellDetail({ state: 'in_progress', claimedTask: 7, proof: null, lastCheck: null }));
    draw();
    expect((await screen.findByTestId('cell-claimed')).textContent).toBe('Task #7');
  });

  it('makes a task for an unclaimed gap in the chat picked, and opens it', async () => {
    cell.mockResolvedValue(makeCellDetail({ state: 'gap', reason: 'No test', proof: null, lastCheck: null, provedAt: null }));
    createForCells.mockResolvedValue({ task: { projectId: 'p1', number: 15 }, sessionId: 's1' });
    const onOpenChat = vi.fn();
    const onCreated = vi.fn();
    render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" onClose={vi.fn()} onOpenChat={onOpenChat} onCreated={onCreated} />);
    fireEvent.click(await screen.findByTestId('cell-create-task'));
    fireEvent.click(await screen.findByTestId('create-task-chat'));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith('s1'));
    expect(createForCells).toHaveBeenCalledWith('p1', { slug: 'camera', rows: ['glare'], cols: ['gpu'], onlyGaps: false }, 's1');
    expect(onCreated).toHaveBeenCalled();
  });
});
