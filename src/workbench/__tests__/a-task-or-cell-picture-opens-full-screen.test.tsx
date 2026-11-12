/**
 * A picture on a task card or a grid cell is the chat's own picture: the same
 * zoom badge and the same full-screen viewer on a click; a before and after
 * pair is the chat's comparison, opening the viewer's comparison.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCellDetail } from '@/workbench/grids/__tests__/fixtures';
import { CellDetailPanel } from '@/workbench/grids/cell-detail';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { TaskCard } from '@/workbench/tasks/task-card';

const cell = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  grids: { list: vi.fn(), get: vi.fn(), cell: (...args: unknown[]) => cell(...args), act: vi.fn() },
}));
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: () => () => {},
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const asset = (c: string) => `/api/presentation-assets/${c.repeat(64)}.png`;

beforeEach(() => {
  cell.mockReset();
});

/** Opens the picture named `alt` and checks the viewer shows that picture. */
function opensFullScreen(alt: string, src: string) {
  expect(screen.queryByTestId('picture-viewer')).toBeNull();
  const button = screen.getByRole('button', { name: `Open ${alt} to zoom` });
  expect(button.closest('[data-testid="zoomable-image"]')).not.toBeNull();
  fireEvent.click(button);
  const viewer = screen.getByTestId('picture-viewer');
  expect(viewer).toBeVisible();
  expect(within(viewer).getByAltText(alt)).toHaveAttribute('src', src);
}

const renderPlan = {
  outcome: 'HDR sky lighting',
  scenes: [
    { id: 'hall', name: 'Great hall', scene: 'hall.gltf', camera: 'door', shows: 'Sky light', existed: true, reference: true },
    { id: 'yard', name: 'Yard', scene: 'yard.gltf', camera: 'gate', shows: 'Moonlight' },
  ],
};

describe('a picture on a task card', () => {
  it('a new item shows its after as the chat picture, opening full screen', () => {
    const task = makeTask({ type: 'render_feature', status: 'in_progress', plan: renderPlan, checks: { scenes: [{ id: 'yard', after: asset('d') }] } });
    render(<TaskCard task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show after' }));
    expect(screen.queryByTestId('image-comparison')).toBeNull();
    opensFullScreen('Yard after', asset('d'));
  });

  it('a before and after is the chat comparison, and the reference the chat picture', () => {
    const task = makeTask({ type: 'render_feature', status: 'in_progress', plan: renderPlan, checks: { scenes: [{ id: 'hall', before: asset('a'), after: asset('b'), reference: asset('c') }] } });
    render(<TaskCard task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show before, after and reference' }));
    expect(screen.getByTestId('image-comparison')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Great hall after comparison to zoom' }));
    expect(screen.getByTestId('picture-viewer-comparison')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  it('the reference opens full screen', () => {
    const task = makeTask({ type: 'render_feature', status: 'in_progress', plan: renderPlan, checks: { scenes: [{ id: 'hall', before: asset('a'), after: asset('b'), reference: asset('c') }] } });
    render(<TaskCard task={task} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show before, after and reference' }));
    opensFullScreen('Great hall reference', asset('c'));
  });

  it('a picture named as evidence opens full screen', () => {
    const task = makeTask({
      type: 'feature', status: 'in_progress',
      plan: { outcome: 'Export', criteria: [{ id: 'a', text: 'Export button' }] },
      checks: { criteria: [{ id: 'a', met: true, evidence: asset('e') }] },
    });
    render(<TaskCard task={task} />);
    opensFullScreen(asset('e'), asset('e'));
  });

  it('a done feature: a screenshot pair is the comparison, a lone one opens full screen', () => {
    const screens = [{ name: 'Export menu', before: asset('a'), after: asset('b') }, { name: 'Export dialog', after: asset('c') }];
    render(<TaskCard task={makeTask({
      type: 'feature', status: 'done', plan: { outcome: 'Export', criteria: [{ id: 'a', text: 'Export button' }] },
      result: { summary: 'Export', commits: ['abcdef1'], criteria: [{ id: 'a', met: true, evidence: 'e2e' }], screens },
    })} />);
    const shots = screen.getByTestId('task-screenshots');
    fireEvent.click(within(shots).getByRole('button', { name: 'Show before and after' }));
    expect(within(shots).getByTestId('image-comparison')).toBeInTheDocument();
    fireEvent.click(within(shots).getByRole('button', { name: 'Show after' }));
    opensFullScreen('Export dialog after', asset('c'));
  });
});

describe('a picture on a grid cell', () => {
  it('evidence opens full screen', async () => {
    const detail = makeCellDetail();
    cell.mockResolvedValue({ ...detail, cell: { ...detail.cell, proof: { ...detail.cell.proof!, evidence: [asset('f')] } } });
    render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" onClose={vi.fn()} />);
    await screen.findByTestId('cell-proof');
    opensFullScreen(asset('f'), asset('f'));
  });
});
