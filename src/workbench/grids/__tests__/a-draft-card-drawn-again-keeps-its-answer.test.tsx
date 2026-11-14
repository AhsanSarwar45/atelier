/**
 * A long chat keeps only the rows near the screen mounted, so a card is
 * unmounted and drawn again as it scrolls. A grid draft card that was read
 * once must draw its last known state at once when drawn again. Drawing the
 * stored pending draft first grows the card by a screen and shrinks it when
 * the read returns, and in a chat held at the end that scrolls the card out
 * and back in, over and over: the chat flickers.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GridCard } from '@/workbench/grids/grid-card';
import { makeDetail, makeGrid } from '@/workbench/grids/__tests__/fixtures';

const get = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: {
    list: vi.fn(async () => ({ projectId: 'p1', grids: [], templates: [] })),
    get: (...args: unknown[]) => get(...args),
    cell: vi.fn(),
    act: vi.fn(),
  },
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat&chat=s1'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const PENDING = {
  slug: 'species',
  title: 'Grass species',
  area: 'The grass species',
  row_search: { command: 'ls species', watch: ['species'] },
  columns: [{ id: 'lod', name: 'LOD', proof_rule: 'A LOD test' }],
  rows: [{ id: 'fescue', name: 'Fescue' }],
};

// As the transcript printed it: a draft waiting for the owner.
const printed = makeGrid({ slug: 'species', status: 'draft', pending: PENDING, percent: null, approvedAt: null });
// As it is now: approved, nothing pending.
const approved = makeGrid({ slug: 'species', status: 'approved', pending: null });

beforeEach(() => {
  get.mockReset().mockResolvedValue(makeDetail({ grid: approved, rows: [], cells: [], columns: [] }));
});

describe('a grid draft card drawn again', () => {
  it('draws the answer it already read, not the stored draft', async () => {
    const card = <GridCard widget={{ type: 'grid', event: 'draft', grid: printed }} />;
    const first = render(card);
    await waitFor(() => expect(screen.getByTestId('grid-card-label').textContent).toBe('Grid approved'));
    first.unmount();

    render(card);
    expect(screen.getByTestId('grid-card-label').textContent).toBe('Grid approved');
    expect(screen.queryByTestId('grid-card-more')).toBeNull();
  });
});
