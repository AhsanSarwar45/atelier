/**
 * Notes on a cell (docs/grids.md, "Notes"): the cell's own, and its row's,
 * column's and grid's, each labelled with where it was left; and a box to
 * add one.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CellDetailPanel } from '@/workbench/grids/cell-detail';
import { makeCellDetail } from '@/workbench/grids/__tests__/fixtures';

const cell = vi.fn();
const act = vi.fn();
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    grids: { list: vi.fn(), get: vi.fn(), cell: (...args: unknown[]) => cell(...args), act: (...args: unknown[]) => act(...args) },
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

const notes = [
  { scope: 'cell', text: "glare's kernel reads iris.wgsl", actor: 'agent', sessionId: 's1', at: 1 },
  { scope: 'row', text: 'glare is being rewritten in cor-x198', actor: 'owner', sessionId: null, at: 2 },
];

beforeEach(() => {
  cell.mockReset().mockResolvedValue({ ...makeCellDetail(), notes });
  act.mockReset().mockResolvedValue({ summary: 'ok' });
});

const draw = () => render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" onClose={vi.fn()} />);

describe('notes on a cell', () => {
  it('shows each note with where it was left', async () => {
    draw();
    const shown = await screen.findByTestId('cell-notes');
    const items = within(shown).getAllByTestId('note');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("glare's kernel reads iris.wgsl");
    expect(items[1].textContent).toContain('glare is being rewritten in cor-x198');
    expect(items[1].textContent).toContain('Row');
  });

  it('adds a note to the cell and shows the cell again', async () => {
    draw();
    const shown = await screen.findByTestId('cell-notes');
    fireEvent.change(within(shown).getByRole('textbox', { name: 'Add a note' }), { target: { value: 'needs the lavapipe driver' } });
    fireEvent.click(within(shown).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith('note', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, { text: 'needs the lavapipe driver' }),
    );
    await waitFor(() => expect(cell).toHaveBeenCalledTimes(2));
  });
});
