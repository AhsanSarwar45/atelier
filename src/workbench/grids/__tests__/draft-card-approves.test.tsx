/**
 * The `grid` chat widget (docs/grids.md, "Cards"): `atelier grid` output is
 * read as one, the draft card starts open with Approve and Discard, the N/A
 * card carries the owner's buttons, and the rest start folded.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const PENDING = {
  slug: 'camera',
  title: 'Renderer camera',
  area: 'The renderer camera features',
  row_search: { command: 'ls src/camera', watch: ['src/camera'] },
  columns: [{ id: 'cpu', name: 'CPU', proof_rule: 'A CPU test' }, { id: 'gpu', name: 'GPU', proof_rule: 'A GPU test' }],
  rows: [{ id: 'glare', name: 'Glare' }, { id: 'sunstar', name: 'Sunstar' }],
};

const draftGrid = makeGrid({ status: 'draft', pending: PENDING, percent: null, approvedAt: null });

beforeEach(() => {
  get.mockReset().mockResolvedValue(makeDetail({ grid: draftGrid, rows: [], cells: [], columns: [] }));
  list.mockReset().mockResolvedValue({ projectId: 'p1', grids: [draftGrid], templates: [] });
  cell.mockReset().mockResolvedValue(makeCellDetail({ state: 'na_pending', reason: 'No CPU path', proof: null, lastCheck: null }));
  act.mockReset().mockResolvedValue({ summary: 'ok' });
  push.mockReset();
});

describe('the grid widget', () => {
  it('is read from a block, and `atelier grid` is a presenter', () => {
    const value = { type: 'grid', event: 'draft', grid: draftGrid };
    expect(widget(value)).toEqual(value);
    expect(widgetBlock(value)).toContain('"type":"grid"');
    expect(widget({ type: 'grid', event: 'draft' })).toBeNull();
    expect(widget({ type: 'grid', event: 'draft', grid: { ...draftGrid, slug: 'Not A Slug' } })).toBeNull();
    expect(widget({ type: 'grid', event: 'template', template: { name: 'renderer', columns: [] } })).not.toBeNull();
    const tool = (title: string) => ({ kind: 'tool', id: 't', name: 'Bash', title, input: {} }) as unknown as TranscriptTool;
    expect(ranThePresenter(tool('atelier grid draft --file draft.json'))).toBe(true);
    expect(ranThePresenter(tool('atelier tool grid prove camera glare gpu'))).toBe(true);
    expect(ranThePresenter(tool('atelier gridlock'))).toBe(false);
  });

  it('starts a draft open, with the draft and Approve and Discard', async () => {
    render(<GridCard widget={{ type: 'grid', event: 'draft', grid: draftGrid }} />);
    const draft = await screen.findByTestId('grid-draft');
    expect(screen.getByTestId('grid-card-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(draft.textContent).toContain('Glare');
    expect(draft.textContent).toContain('A GPU test');
    fireEvent.click(screen.getByTestId('grid-approve'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('approve', { projectId: 'p1', slug: 'camera' }));
  });

  it('discards a draft', async () => {
    render(<GridCard widget={{ type: 'grid', event: 'draft', grid: draftGrid }} />);
    fireEvent.click(await screen.findByTestId('grid-discard'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('discard', { projectId: 'p1', slug: 'camera' }));
  });

  it('says what became of a draft once it is answered, and only that', async () => {
    const approved = makeGrid();
    get.mockResolvedValue(makeDetail({ grid: approved }));
    render(<GridCard widget={{ type: 'grid', event: 'draft', grid: draftGrid }} />);
    await waitFor(() => expect(screen.getByTestId('grid-card-label').textContent).toBe('Grid approved'));
    // The line shows where the grid stands now, never "draft" and "approved" at once.
    expect(screen.getByTestId('grid-card').textContent).not.toMatch(/draft/i);
    expect(screen.getByTestId('grid-card')).toHaveAttribute('data-waiting', 'no');
    expect(screen.queryByTestId('grid-approve')).toBeNull();
  });

  it('starts an N/A card open with the owner buttons after the reason, Open grid beside them', async () => {
    const w: GridWidget = { type: 'grid', event: 'na', grid: makeGrid(), cell: { row: 'both', col: 'cpu', state: 'na_pending', reason: 'No CPU path' } };
    render(<GridCard widget={w} />);
    const approve = await screen.findByTestId('cell-approve-na');
    // One row of buttons: Approve N/A, Reject and Open grid.
    const buttons = approve.parentElement!;
    expect(within(buttons).getByTestId('cell-reject-na')).toBeVisible();
    expect(within(buttons).getByTestId('grid-open')).toBeVisible();
    expect(screen.getAllByTestId('grid-open')).toHaveLength(1);
    const more = screen.getByTestId('grid-card-more');
    expect(within(more).getByTestId('grid-cell-reason').compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Folded, the buttons stay on the line.
    fireEvent.click(screen.getByTestId('grid-card-toggle'));
    expect(screen.queryByTestId('grid-card-more')).toBeNull();
    fireEvent.click(screen.getByTestId('cell-approve-na'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('approve_na', { projectId: 'p1', slug: 'camera', row: 'both', col: 'cpu' }, undefined));
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
