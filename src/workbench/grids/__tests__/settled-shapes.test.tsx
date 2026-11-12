/**
 * The shapes the server settled on (docs/grids.md, "HTTP" and "Claims"): a
 * task's card lists its cells with their states and rereads them when grids
 * change, a proposal names the cells it asks for, Re-check stale asks for the
 * stale cells only and says what failed, a cell's Re-check says why it
 * reopened, and the template card has no grid, starts open and names the
 * template in `slug`.
 */
import { act as react, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCellDetail, makeDetail } from '@/workbench/grids/__tests__/fixtures';
import { CellDetailPanel } from '@/workbench/grids/cell-detail';
import { GridCard } from '@/workbench/grids/grid-card';
import { widget } from '@/workbench/chat-widgets';
import type { GridWidget } from '@/workbench/grids/types';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { ProposalCard, TaskCard } from '@/workbench/tasks/task-card';
import TasksTab from '@/workbench/tasks/tasks-tab';
import type { TaskProposal } from '@/workbench/tasks/types';

const gridGet = vi.fn();
const gridList = vi.fn();
const gridCell = vi.fn();
const gridAct = vi.fn();
const taskGet = vi.fn();
const proposalGet = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { list: vi.fn(async () => []), get: (...args: unknown[]) => taskGet(...args), act: vi.fn(), proposal: (...args: unknown[]) => proposalGet(...args) },
  grids: {
    list: (...args: unknown[]) => gridList(...args),
    get: (...args: unknown[]) => gridGet(...args),
    cell: (...args: unknown[]) => gridCell(...args),
    act: (...args: unknown[]) => gridAct(...args),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
const frames: Array<(data: string) => void> = [];
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: ({ frame }: { frame: (data: string) => void }) => {
    frames.push(frame);
    return () => { frames.splice(frames.indexOf(frame), 1); };
  },
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat&chat=s1'),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

beforeEach(() => {
  frames.length = 0;
  gridGet.mockReset().mockResolvedValue(makeDetail());
  gridList.mockReset().mockResolvedValue({ projectId: 'p1', grids: [], templates: [] });
  gridCell.mockReset().mockResolvedValue(makeCellDetail());
  gridAct.mockReset().mockResolvedValue({ summary: 'ok' });
  taskGet.mockReset();
  proposalGet.mockReset();
  push.mockReset();
});

describe("a task's cells", () => {
  const cells = [
    { grid: 'camera', row: 'glare', col: 'gpu', state: 'in_progress', claimed: true, reason: null },
    { grid: 'camera', row: 'sunstar', col: 'gpu', state: 'gap', claimed: false, reason: 'Checks failed' },
  ];

  it('are listed on the card with their states, and open the cell', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress', cells })} />);
    const listed = screen.getAllByTestId('task-cell');
    expect(listed.map((el) => [el.dataset.cell, el.dataset.state])).toEqual([
      ['camera.glare.gpu', 'in_progress'],
      ['camera.sunstar.gpu', 'gap'],
    ]);
    expect(listed[0]!.textContent).toContain('In progress');
    expect(listed[1]!.textContent).toContain('Released');
    expect(listed[1]!.textContent).toContain('Checks failed');
    fireEvent.click(within(listed[0]!).getByTestId('task-cell-open'));
    expect(push.mock.calls[0]![0]).toContain('grid=camera');
    expect(push.mock.calls[0]![0]).toContain('cell=glare%3Agpu');
  });

  it('are read again when the grids change', async () => {
    taskGet.mockResolvedValue({ task: makeTask({ cells: [{ ...cells[0]!, state: 'proved' }] }), events: [] });
    render(<TaskCard task={makeTask({ status: 'in_progress', cells: [cells[0]!] })} />);
    expect(screen.getByTestId('task-cell').dataset.state).toBe('in_progress');
    react(() => { for (const frame of [...frames]) frame(JSON.stringify({ type: 'grids.changed', projectId: 'p1', slug: 'camera' })); });
    await waitFor(() => expect(screen.getByTestId('task-cell').dataset.state).toBe('proved'));
  });

  it('are left out of a card with none', () => {
    render(<TaskCard task={makeTask()} />);
    expect(screen.queryByTestId('task-cells')).toBeNull();
  });

  it('are named on a proposal', () => {
    const proposal: TaskProposal = {
      projectId: 'p1', id: 3, sessionId: 's1', type: 'feature', title: 'Glare on GPU', why: '', plan: {},
      status: 'created', taskNumber: 4, createdAt: 1, decidedAt: 2,
      cells: [{ grid: 'camera', row: 'glare', col: 'gpu' }],
    };
    render(<ProposalCard proposal={proposal} />);
    expect(screen.getByTestId('proposal-cells').textContent).toContain('glare × gpu');
  });
});

describe('re-checking', () => {
  it('Re-check stale asks for the stale cells only and says what failed', async () => {
    gridAct.mockResolvedValue({ grid: makeDetail().grid, widget: null, summary: 'Re-checked 1 stale cell of "camera": 0 passed, 1 failed.\n- camera.glare.gpu: exit 1', failed: 'camera.glare.gpu: exit 1' });
    render(<TasksTab projectId="p1" view="grids" grid="camera" cell={null} onShowGrid={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('grid-recheck-stale'));
    await waitFor(() => expect(gridAct).toHaveBeenCalledWith('verify', { projectId: 'p1', slug: 'camera' }, { staleOnly: true }));
    const answer = await screen.findByTestId('grid-recheck-answer');
    expect(answer.dataset.failed).toBe('yes');
    expect(answer.textContent).toContain('0 passed, 1 failed');
  });

  it("a cell's Re-check says why it reopened", async () => {
    gridAct.mockResolvedValue({ summary: 'Reopened', failed: 'glare ground truth exited 1' });
    render(<CellDetailPanel projectId="p1" slug="camera" row="glare" col="gpu" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('cell-recheck'));
    await waitFor(() => expect(gridAct).toHaveBeenCalledWith('verify', { projectId: 'p1', slug: 'camera', row: 'glare', col: 'gpu' }, undefined));
    expect((await screen.findByTestId('cell-check-failed')).textContent).toContain('glare ground truth exited 1');
  });
});

describe('the template card', () => {
  const template: GridWidget = {
    type: 'grid',
    event: 'template',
    template: {
      name: 'renderer',
      projectId: 'p1',
      columns: [{ id: 'cpu', name: 'CPU', proof_rule: 'A CPU test' }],
      pending: { columns: [{ id: 'cpu', name: 'CPU', proof_rule: 'A CPU test' }, { id: 'gpu', name: 'GPU', proof_rule: 'A GPU test' }] },
      updatedAt: 1,
      change: { added: ['gpu'], removed: [], changed: [], affects: ['camera'], clashes: [] },
    },
  };

  it('has no grid, starts open, and approves by the template name', async () => {
    expect(widget(template as unknown as Record<string, unknown>)).not.toBeNull();
    gridList.mockResolvedValue({ projectId: 'p1', grids: [], templates: [template.template] });
    render(<GridCard widget={template} />);
    expect(screen.getByTestId('grid-card-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('grid-template-affected').textContent).toContain('camera');
    fireEvent.click(screen.getByTestId('grid-template-approve'));
    await waitFor(() => expect(gridAct).toHaveBeenCalledWith('approve_template', { projectId: 'p1', slug: 'renderer' }));
  });
});
