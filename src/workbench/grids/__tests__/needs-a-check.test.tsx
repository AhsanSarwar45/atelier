/**
 * Cells with no check (docs/grids.md, "Checks"): marked in the heatmap and
 * named in the legend, said in the cell detail beside the cell's checks, the
 * column's checks in its header tip, and left out of Create task with a count.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CellDetailPanel } from '@/workbench/grids/cell-detail';
import { columnTip, GridHeatmap, Legend, orderRows } from '@/workbench/grids/grid-heatmap';
import GridsView from '@/workbench/grids/grids-view';
import { needsACheck } from '@/workbench/grids/types';
import { makeCell, makeCellDetail, makeColumn, makeDetail } from '@/workbench/grids/__tests__/fixtures';

const get = vi.fn();
const cell = vi.fn();
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    grids: { list: vi.fn(), get: (...args: unknown[]) => get(...args), cell: (...args: unknown[]) => cell(...args), act: vi.fn() },
    tasks: { ...real.tasks, createForCells: vi.fn() },
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
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=tasks&view=grids&grid=camera'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const tested = { name: 'tested', command: 'sh tests/{row}.sh', kind: 'test', files: ['tests/{row}.sh'] };

/** The camera grid with checks on cpu only: every open gpu cell needs a check. */
function checkedDetail() {
  const detail = makeDetail();
  detail.columns = detail.columns.map((c) => (c.id === 'cpu' ? { ...c, checks: [tested] } : c));
  detail.cells = detail.cells.map((c) => (c.col === 'gpu' ? { ...c, needsCheck: true } : { ...c, checks: [{ ...tested, command: `sh tests/${c.row}.sh` }] }));
  return detail;
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(checkedDetail());
});

describe('cells that need a check', () => {
  it('counts only an open cell that is not a reference', () => {
    expect(needsACheck(makeCell('a', 'b', { needsCheck: true }))).toBe(true);
    expect(needsACheck(makeCell('a', 'b', { needsCheck: true, state: 'gap' }))).toBe(true);
    expect(needsACheck(makeCell('a', 'b', { needsCheck: true, state: 'proved' }))).toBe(false);
    expect(needsACheck(makeCell('a', 'b', { needsCheck: true, state: 'na' }))).toBe(false);
    expect(needsACheck(makeCell('a', 'b', { needsCheck: true, ref: true }))).toBe(false);
    expect(needsACheck(makeCell('a', 'b'))).toBe(false);
  });

  it('marks them in the heatmap and names the mark in the legend', () => {
    const detail = checkedDetail();
    render(<GridHeatmap rows={orderRows(detail.rows)} columns={detail.columns.filter((c) => !c.retired)} cells={detail.cells}
      selection={null} onSelect={vi.fn()} onOpenCell={vi.fn()} />);
    const marked = screen.getAllByTestId('grid-cell').filter((el) => el.dataset.needsCheck === 'yes').map((el) => `${el.dataset.row}.${el.dataset.col}`);
    // A stale or in-progress cell keeps its mark; both.gpu is n/a and tonemap a reference.
    expect(marked.sort()).toEqual(['fog.gpu', 'glare.gpu', 'sunstar.gpu']);
    expect(screen.getAllByTestId('grid-cell').find((el) => el.dataset.row === 'fog' && el.dataset.col === 'gpu')!.getAttribute('aria-label')).toContain('needs a check');
    render(<Legend />);
    expect(screen.getByTestId('grid-legend-needs-check').textContent).toContain('Needs a check');
  });

  it('lists a column\'s checks in its header tip, or says it has none', () => {
    expect(columnTip(makeColumn('cpu', { checks: [tested] }))).toBe('CPU: Proof for cpu\nChecks: sh tests/{row}.sh');
    expect(columnTip(makeColumn('gpu'))).toBe('GPU: Proof for gpu\nNo checks: its cells need one');
  });

  it('leaves them out of Create task and says how many', async () => {
    const detail = checkedDetail();
    detail.cells = detail.cells.map((c) => (c.row === 'sunstar' && c.col === 'gpu' ? { ...c, state: 'gap', claimedTask: null } : c));
    get.mockReset().mockResolvedValue(detail);
    render(<GridsView projectId="p1" grid="camera" cell={null} onShow={vi.fn()} onOpenChat={vi.fn()} onOpenTask={vi.fn()} />);
    fireEvent.click((await screen.findAllByTestId('grid-row-name')).find((el) => el.textContent === 'Sunstar')!);
    const bar = screen.getByTestId('grid-selection');
    expect(within(bar).getByTestId('grid-selection-needs-check').textContent).toBe('1 cell needs a check');
    expect(within(bar).getByTestId('grid-create-task').textContent).toBe('Create task · 1 cell');
  });
});

describe('the cell detail', () => {
  const draw = () => render(<CellDetailPanel projectId="p1" slug="camera" row="fog" col="gpu" onClose={vi.fn()} />);

  it('says a cell needs a check', async () => {
    cell.mockReset().mockResolvedValue({ ...makeCellDetail({ state: 'unchecked', proof: null, lastCheck: null, merged: false, needsCheck: true }) });
    draw();
    const notice = await screen.findByTestId('cell-needs-check');
    expect(notice.textContent).toContain('Needs a check');
    expect(notice.textContent).toContain('GPU column');
    expect(screen.queryByTestId('cell-checks')).toBeNull();
  });

  it('lists the checks that prove it', async () => {
    cell.mockReset().mockResolvedValue(makeCellDetail({ checks: [{ ...tested, command: 'sh tests/glare.sh', files: ['tests/glare.sh'] }] }));
    draw();
    const checks = await screen.findByTestId('cell-checks');
    expect(within(checks).getByTestId('check').dataset.check).toBe('tested');
    expect(within(checks).getByTestId('check-command').textContent).toBe('sh tests/glare.sh');
    expect(checks.textContent).toContain('Files: tests/glare.sh');
    expect(screen.queryByTestId('cell-needs-check')).toBeNull();
  });
});
