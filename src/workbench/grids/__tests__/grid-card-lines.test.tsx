/**
 * The `grid` chat widget (docs/grids.md, "Cards"): `atelier grid` output is
 * read as one, and every line is a read-only summary that starts folded:
 * nothing in a grid waits for the owner.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { widget, widgetBlock } from '@/workbench/chat-widgets';
import { GridCard } from '@/workbench/grids/grid-card';
import type { GridWidget } from '@/workbench/grids/types';
import { makeCellDetail, makeDetail, makeGrid } from '@/workbench/grids/__tests__/fixtures';
import { ranThePresenter } from '@/workbench/presented';
import type { TranscriptTool } from '@/workbench/fold';

const get = vi.fn();
const list = vi.fn();
const cell = vi.fn();
const act = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
    cell: (...args: unknown[]) => cell(...args),
    act: (...args: unknown[]) => act(...args),
  },
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

const savedGrid = makeGrid();

beforeEach(() => {
  get.mockReset().mockResolvedValue(makeDetail({ grid: savedGrid }));
  list.mockReset().mockResolvedValue({ projectId: 'p1', grids: [savedGrid], templates: [] });
  cell.mockReset().mockResolvedValue(makeCellDetail({ state: 'na', reason: 'No CPU path', proof: null, lastCheck: null }));
  act.mockReset().mockResolvedValue({ summary: 'ok' });
  push.mockReset();
});

describe('the grid widget', () => {
  it('is read from a block, and `atelier grid` is a presenter', () => {
    const value = { type: 'grid', event: 'draft', grid: savedGrid };
    expect(widget(value)).toEqual(value);
    expect(widgetBlock(value)).toContain('"type":"grid"');
    expect(widget({ type: 'grid', event: 'draft' })).toBeNull();
    expect(widget({ type: 'grid', event: 'draft', grid: { ...savedGrid, slug: 'Not A Slug' } })).toBeNull();
    expect(widget({ type: 'grid', event: 'template', template: { name: 'renderer', columns: [] } })).not.toBeNull();
    const tool = (title: string) => ({ kind: 'tool', id: 't', name: 'Bash', title, input: {} }) as unknown as TranscriptTool;
    expect(ranThePresenter(tool('atelier grid draft --file draft.json'))).toBe(true);
    expect(ranThePresenter(tool('atelier tool grid prove camera glare gpu'))).toBe(true);
    expect(ranThePresenter(tool('atelier gridlock'))).toBe(false);
  });

  it('draws a saved grid as one line that opens the grid, with nothing to unfold or approve', async () => {
    render(<GridCard widget={{ type: 'grid', event: 'draft', grid: savedGrid }} />);
    expect(screen.getByTestId('grid-card-label').textContent).toBe('Grid saved');
    expect(screen.getByTestId('grid-card-what').textContent).toBe('Renderer camera');
    expect(screen.queryByTestId('grid-card-toggle')).toBeNull();
    expect(screen.getByTestId('grid-card')).not.toHaveAttribute('data-waiting');
    expect(screen.queryByTestId('grid-card-actions')).toBeNull();
    expect(screen.queryByTestId('grid-approve')).toBeNull();
    expect(screen.queryByTestId('grid-discard')).toBeNull();
    fireEvent.click(await screen.findByTestId('grid-card-what'));
    expect(push.mock.calls[0]![0]).toContain('grid=camera');
    expect(act).not.toHaveBeenCalled();
  });

  it('draws an N/A as a folded line with its reason, and no owner buttons', async () => {
    const w: GridWidget = { type: 'grid', event: 'na', grid: makeGrid(), cell: { row: 'both', col: 'cpu', state: 'na', reason: 'No CPU path' } };
    render(<GridCard widget={w} />);
    expect(screen.getByTestId('grid-card-label').textContent).toBe('Marked N/A');
    expect(screen.getByTestId('grid-card-toggle').getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(cell).toHaveBeenCalled());
    expect(screen.queryByTestId('cell-approve-na')).toBeNull();
    expect(screen.queryByTestId('cell-reject-na')).toBeNull();
    fireEvent.click(screen.getByTestId('grid-card-toggle'));
    expect(screen.getByTestId('grid-cell-reason').textContent).toBe('No CPU path');
    expect(screen.getByTestId('grid-open')).toBeVisible();
    expect(screen.queryByTestId('cell-approve-na')).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('draws a proof as one folded line: what happened, the cell and the grid', async () => {
    cell.mockResolvedValue(makeCellDetail());
    const w: GridWidget = { type: 'grid', event: 'prove', grid: makeGrid(), cell: { row: 'glare', col: 'gpu', state: 'proved' } };
    render(<GridCard widget={w} />);
    expect(screen.getByTestId('grid-card-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('grid-cell-card')).toBeNull();
    expect(screen.getByTestId('grid-card-label').textContent).toBe('Proved');
    await waitFor(() => expect(screen.getByTestId('grid-card-what').textContent).toBe('Glare × GPU · camera'));
    fireEvent.click(screen.getByTestId('grid-card-toggle'));
    expect(screen.getByTestId('grid-cell-card')).toHaveTextContent('Glare kernel matches the reference renderer');
  });
});
