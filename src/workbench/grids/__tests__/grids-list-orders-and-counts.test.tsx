/**
 * The Grids view's list (docs/grids.md, "Grids list"): drafts first, then the
 * lowest percent; discarded grids left out; each row's percent and its gap,
 * stale and N/A pending counts; templates listed, read-only.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridsList, orderGrids } from '@/workbench/grids/grids-view';
import { makeGrid } from '@/workbench/grids/__tests__/fixtures';

const list = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: { list: (...args: unknown[]) => list(...args), get: vi.fn(), cell: vi.fn(), act: vi.fn() },
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));

const counts = (over: Partial<ReturnType<typeof makeGrid>['counts']> = {}) => ({
  counted: 10, proved: 0, stale: 0, gap: 0, unchecked: 10, inProgress: 0, naPending: 0, na: 0, ...over,
});

const grids = [
  makeGrid({ slug: 'colour', title: 'Colour', percent: 80, counts: counts({ proved: 8, gap: 2 }) }),
  makeGrid({ slug: 'camera', title: 'Camera', percent: 20, counts: counts({ proved: 2, stale: 3, naPending: 1 }), pending: { title: 'Camera' } }),
  makeGrid({ slug: 'old', title: 'Old', status: 'discarded', percent: null }),
  makeGrid({ slug: 'fresh', title: 'Fresh', status: 'draft', percent: null, pending: { title: 'Fresh' } }),
];

beforeEach(() => {
  list.mockReset().mockResolvedValue({
    projectId: 'p1',
    grids,
    templates: [{ name: 'renderer', columns: [{ id: 'cpu', name: 'CPU', proofRule: 'x' }, { id: 'gpu', name: 'GPU', proofRule: 'y' }], pending: null, updatedAt: 1 }],
  });
});

describe('the grids list', () => {
  it('puts drafts first, then the lowest percent, and leaves discarded grids out', () => {
    expect(orderGrids(grids).map((g) => g.slug)).toEqual(['fresh', 'camera', 'colour']);
  });

  it('shows each grid with its counts, and an awaiting-approval chip', async () => {
    const onOpen = vi.fn();
    render(<GridsList projectId="p1" onOpen={onOpen} />);
    const rows = await screen.findAllByTestId('grid-list-row');
    expect(rows.map((row) => row.dataset.slug)).toEqual(['fresh', 'camera', 'colour']);
    const camera = rows[1]!;
    expect(within(camera).getByTestId('grid-stale').textContent).toBe('3 stale');
    expect(within(camera).getByTestId('grid-na-pending').textContent).toBe('1 N/A pending');
    expect(within(camera).getByTestId('grid-awaiting')).toBeTruthy();
    expect(within(camera).queryByTestId('grid-gaps')).toBeNull();
    // Proved over the cells that count, beside the bar.
    expect(within(camera).getByTestId('grid-percent').dataset.percent).toBe('20');
    expect(within(camera).getByTestId('grid-proved').textContent).toBe('2/10 proved');
    expect(within(rows[2]!).getByTestId('grid-gaps').textContent).toBe('2 gap');
    expect(within(rows[0]!).queryByTestId('grid-percent')).toBeNull();
    fireEvent.click(camera);
    expect(onOpen).toHaveBeenCalledWith('camera');
  });

  it('lists templates, read-only', async () => {
    render(<GridsList projectId="p1" onOpen={vi.fn()} />);
    const template = await screen.findByTestId('grid-template-row');
    expect(template.textContent).toContain('renderer');
    expect(template.textContent).toContain('CPU · GPU');
    expect(within(template).queryByRole('button')).toBeNull();
  });
});
