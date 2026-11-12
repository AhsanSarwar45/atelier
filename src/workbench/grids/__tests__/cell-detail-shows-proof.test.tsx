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
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: { list: vi.fn(), get: vi.fn(), cell: (...args: unknown[]) => cell(...args), act: (...args: unknown[]) => act(...args) },
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

  it('links the task that claims it', async () => {
    cell.mockResolvedValue(makeCellDetail({ state: 'in_progress', claimedTask: 7, proof: null, lastCheck: null }));
    const { onOpenTask } = draw();
    fireEvent.click(await screen.findByTestId('cell-claimed'));
    expect(onOpenTask).toHaveBeenCalledWith(7);
  });
});
