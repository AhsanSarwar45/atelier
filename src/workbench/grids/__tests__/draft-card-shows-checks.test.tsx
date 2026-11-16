/**
 * The draft and edit card (docs/grids.md, "Cards"): each column shows the
 * checks that prove it, and an edit names what it adds and removes by the
 * names the owner reads, with the new column marked in the list.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DraftView } from '@/workbench/grids/grid-card';
import { draftContent, draftDiff } from '@/workbench/grids/types';
import { makeColumn, makeDetail, makeRow } from '@/workbench/grids/__tests__/fixtures';

/** What `atelier grid change` leaves waiting: scenes added after gpu, sunstar removed. */
const CHANGE = {
  title: 'Renderer camera',
  area: 'The renderer camera features',
  rowSearch: { command: 'ls src/camera', watch: ['src/camera'] },
  columns: [
    { id: 'gpu', name: 'Runs on the GPU', proofRule: 'a GPU test', checks: [{ name: 'gpu', command: 'cargo test gpu_{row}' }] },
    { id: 'scenes', name: 'Saved scenes', proofRule: 'its checks pass', checks: [{ name: 'scenes', command: 'python scripts/scenes.py {row}' }] },
  ],
  rows: [{ id: 'glare', name: 'Glare', source: 'search' }],
  removeRows: ['sunstar'],
  edit: true,
};

const NOW = makeDetail({
  columns: [makeColumn('gpu', { name: 'Runs on the GPU' })],
  rows: [makeRow('glare'), makeRow('sunstar', { name: 'Sunstar' })],
  cells: [],
});

function show() {
  const draft = draftContent(CHANGE);
  render(<DraftView draft={draft} diff={draftDiff(draft, NOW, CHANGE)} />);
}

describe('the draft card', () => {
  it("shows each column's check commands", () => {
    show();
    const scenes = screen.getAllByTestId('grid-draft-column').find((li) => li.textContent?.includes('Saved scenes'))!;
    expect(scenes, 'the Saved scenes column is not listed').toBeTruthy();
    expect(within(scenes).getByText(/python scripts\/scenes\.py \{row\}/)).toBeTruthy();
  });

  it('names added columns by name, not id', () => {
    show();
    const diff = screen.getByTestId('grid-draft-diff');
    expect(diff.textContent).toContain('Columns added: Saved scenes');
  });

  it('marks the new column in the list', () => {
    show();
    const columns = screen.getAllByTestId('grid-draft-column');
    const scenes = columns.find((li) => li.textContent?.includes('Saved scenes'))!;
    const gpu = columns.find((li) => li.textContent?.includes('Runs on the GPU'))!;
    expect(within(scenes).queryByText('New'), 'the added column is not marked New').toBeTruthy();
    expect(within(gpu).queryByText('New'), 'a kept column is marked New').toBeNull();
  });

  it('lists rows the change removes by name', () => {
    show();
    expect(screen.getByTestId('grid-draft-diff').textContent).toMatch(/Rows removed:.*Sunstar/);
  });
});
