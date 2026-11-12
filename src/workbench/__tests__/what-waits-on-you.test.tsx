/**
 * What waits on the owner besides a chat's permission question — a task in
 * review, a proposal, a plan change, a grid draft, an N/A request — said where
 * he looks: a bar above the composer with the card's own buttons, a badge on
 * the chat's row, a count on the project and the Tasks tab, and a section at
 * the head of the Tasks list.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import type { RestoreRow } from '@/workbench/protocol';
import type { Waiting } from '@/workbench/waiting';

const taskAct = vi.fn();
const answerProposal = vi.fn();
const gridAct = vi.fn();
const taskList = vi.fn();
let waiting: Waiting[] = [];
let rail: RestoreRow[] = [];
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  request: async (path: string) =>
    ({
      ok: true,
      status: 200,
      json: async () => (path.startsWith('/api/workbench/waiting') ? waiting : path.startsWith('/api/workbench/restore') ? rail : []),
    }) as unknown as Response,
  tasks: {
    list: (...args: unknown[]) => taskList(...args),
    get: vi.fn(),
    act: (...args: unknown[]) => taskAct(...args),
    answerProposal: (...args: unknown[]) => answerProposal(...args),
  },
  grids: { act: (...args: unknown[]) => gridAct(...args) },
}));
const feed: Array<{ frame: (data: string) => void }> = [];
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: (listener: { frame: (data: string) => void }) => {
    feed.push(listener);
    return () => { feed.splice(feed.indexOf(listener), 1); };
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo', name: 'Chat one' }],
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat&chat=s1'),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

function anItem(over: Partial<Waiting>): Waiting {
  return {
    key: 'review:p1:11:3', kind: 'review', projectId: 'p1', sessionId: 's1',
    task: 11, proposal: null, grid: null, row: null, col: null,
    title: 'Tidy settings', says: '#11 is ready for review', short: '#11 ready for review', since: 1,
    ...over,
  };
}

const REVIEW = anItem({});
const PROPOSAL = anItem({ key: 'proposal:p1:4', kind: 'proposal', task: null, proposal: 4, title: 'Search filters', says: 'Proposal: Search filters', short: 'Proposal waiting' });
const AMEND = anItem({ key: 'amend:p1:12:5', kind: 'amend', task: 12, says: 'Plan change for #12', short: 'Plan change for #12' });
const DRAFT = anItem({ key: 'grid_draft:p1:data:9', kind: 'grid_draft', task: null, grid: 'data', title: 'Data coverage', says: 'Grid draft: Data coverage', short: 'Grid draft waiting' });
const NA = anItem({ key: 'na:p1:io:import:bench:7', kind: 'na', task: null, grid: 'io', row: 'import', col: 'bench', title: 'Import × Benchmark', says: 'N/A request: Import × Benchmark', short: 'N/A request waiting' });

const TASKS = new Map([
  [11, makeTask({ number: 11, status: 'review', sessionId: 's1' })],
  [12, makeTask({ number: 12, status: 'in_progress', sessionId: 's1', pendingAmend: { plan: {}, at: 1 } as never })],
]);

async function aBar(items: Waiting[], onOpenTask = vi.fn()) {
  const { WaitingBar } = await import('@/workbench/waiting-bar');
  render(<WaitingBar items={items} tasks={TASKS} onOpenTask={onOpenTask} />);
  return onOpenTask;
}

const line = (kind: string) => screen.getAllByTestId('waiting-line').find((l) => l.getAttribute('data-kind') === kind)!;

beforeEach(() => {
  taskAct.mockReset().mockResolvedValue({ task: TASKS.get(11) });
  answerProposal.mockReset().mockResolvedValue({ proposal: { status: 'created' }, task: null });
  gridAct.mockReset().mockResolvedValue({});
  taskList.mockReset().mockResolvedValue([]);
  push.mockReset();
  waiting = [];
  rail = [];
  feed.length = 0;
});

afterEach(async () => {
  (await import('@/workbench/waiting')).resetWaitingForTests();
});

describe('the bar above the composer', () => {
  it('says a review and answers it with the card’s own Approve, Reopen and Open', async () => {
    const opened = await aBar([REVIEW]);
    const review = line('review');
    expect(within(review).getByTestId('waiting-line-says')).toHaveTextContent('#11 is ready for review');

    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(taskAct).toHaveBeenCalledWith('p1', 11, 'approve', undefined));

    // Reopen asks for the note first, as the card does.
    fireEvent.click(within(review).getByRole('button', { name: 'Reopen' }));
    fireEvent.change(within(review).getByLabelText('Note'), { target: { value: 'Not yet' } });
    fireEvent.click(within(review).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(taskAct).toHaveBeenCalledWith('p1', 11, 'reopen', { note: 'Not yet' }));

    fireEvent.click(within(review).getByTestId('waiting-open'));
    expect(opened).toHaveBeenCalledWith(11);
  });

  it('answers a proposal with Create task, Just do it and Cancel', async () => {
    await aBar([PROPOSAL]);
    const proposal = line('proposal');
    expect(proposal).toHaveTextContent('Proposal: Search filters');
    for (const name of ['Create task', 'Just do it', 'Cancel']) expect(within(proposal).getByRole('button', { name })).toBeInTheDocument();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Just do it' }));
    await waitFor(() => expect(answerProposal).toHaveBeenCalledWith('p1', 4, 'just_do_it'));
  });

  it('answers a plan change with Approve change and Reject change', async () => {
    await aBar([AMEND]);
    const amend = line('amend');
    expect(amend).toHaveTextContent('Plan change for #12');
    expect(within(amend).getByRole('button', { name: 'Reject change' })).toBeInTheDocument();
    fireEvent.click(within(amend).getByRole('button', { name: 'Approve change' }));
    await waitFor(() => expect(taskAct).toHaveBeenCalledWith('p1', 12, 'approve_amend', undefined));
  });

  it('approves a grid draft, leaving Discard to the card, and opens the grid', async () => {
    await aBar([DRAFT]);
    const draft = line('grid_draft');
    expect(draft).toHaveTextContent('Grid draft: Data coverage');
    expect(within(draft).queryByRole('button', { name: 'Discard' })).toBeNull();
    fireEvent.click(within(draft).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(gridAct).toHaveBeenCalledWith('approve', { projectId: 'p1', slug: 'data' }));
    fireEvent.click(within(draft).getByTestId('waiting-open'));
    expect(push.mock.calls[0]![0]).toContain('view=grids');
    expect(push.mock.calls[0]![0]).toContain('grid=data');
  });

  it('answers an N/A request with Approve N/A and Reject', async () => {
    await aBar([NA]);
    const na = line('na');
    expect(na).toHaveTextContent('N/A request: Import × Benchmark');
    expect(within(na).getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    fireEvent.click(within(na).getByRole('button', { name: 'Approve N/A' }));
    await waitFor(() =>
      expect(gridAct).toHaveBeenCalledWith('approve_na', { projectId: 'p1', slug: 'io', row: 'import', col: 'bench' }, undefined));
  });

  it('draws nothing when nothing waits', async () => {
    await aBar([]);
    expect(screen.queryByTestId('waiting-bar')).toBeNull();
  });

  it('folds more than two into a count that opens', async () => {
    await aBar([REVIEW, PROPOSAL, AMEND]);
    const toggle = screen.getByTestId('waiting-bar-toggle');
    expect(toggle).toHaveTextContent('3 waiting for you');
    expect(screen.queryAllByTestId('waiting-line')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('waiting-line').map((l) => l.getAttribute('data-kind'))).toEqual(['review', 'proposal', 'amend']);
  });

  it('keeps two open', async () => {
    await aBar([REVIEW, PROPOSAL]);
    expect(screen.queryByTestId('waiting-bar-toggle')).toBeNull();
    expect(screen.getAllByTestId('waiting-line')).toHaveLength(2);
  });
});

describe('the list everything reads', () => {
  it('names a chat’s row Review for one review and Waiting for you otherwise', async () => {
    const { badgeWord } = await import('@/workbench/waiting');
    expect(badgeWord([])).toBeNull();
    expect(badgeWord([REVIEW])).toBe('Review');
    expect(badgeWord([PROPOSAL])).toBe('Waiting for you');
    expect(badgeWord([REVIEW, AMEND])).toBe('Waiting for you');
  });

  it('is read again when a task or grid changes, and the line goes once answered', async () => {
    waiting = [REVIEW];
    const { WaitingCount } = await import('@/workbench/waiting-count');
    render(<WaitingCount projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('project-waiting')).toHaveTextContent('1'));

    waiting = [REVIEW, PROPOSAL];
    act(() => feed.forEach((l) => l.frame(JSON.stringify({ kind: 'tasks.changed', projectId: 'p1', number: null }))));
    await waitFor(() => expect(screen.getByTestId('project-waiting')).toHaveTextContent('2'));

    waiting = [];
    act(() => feed.forEach((l) => l.frame(JSON.stringify({ kind: 'grids.changed', projectId: 'p1', slug: 'data' }))));
    await waitFor(() => expect(screen.queryByTestId('project-waiting')).toBeNull());
  });

  it('counts on the Tasks tab what waits in that project only', async () => {
    waiting = [REVIEW, PROPOSAL, anItem({ key: 'review:p2:1:1', projectId: 'p2' })];
    const { TasksTabCount } = await import('@/workbench/waiting-count');
    render(<TasksTabCount projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('tab-tasks-waiting')).toHaveTextContent('2'));
  });
});

describe('the Tasks tab', () => {
  it('lists what waits first, under Waiting for you, and each task once', async () => {
    waiting = [REVIEW, PROPOSAL, DRAFT];
    taskList.mockResolvedValue([
      makeTask({ number: 11, title: 'Tidy settings', status: 'review', sessionId: 's1' }),
      makeTask({ number: 13, title: 'Another review', status: 'review', sessionId: 's1' }),
      makeTask({ number: 14, title: 'Busy', status: 'in_progress', sessionId: 's1' }),
    ]);
    const TasksTab = (await import('@/workbench/tasks/tasks-tab')).default;
    render(<TasksTab projectId="p1" onOpenChat={() => {}} />);

    const section = await screen.findByTestId('tasks-waiting');
    expect(section).toHaveTextContent('Waiting for you');
    expect(section).toHaveTextContent('3');
    expect(within(section).getAllByTestId('task-row').map((r) => r.getAttribute('data-number'))).toEqual(['11']);
    const others = within(section).getAllByTestId('task-waiting-row');
    expect(others.map((r) => r.getAttribute('data-kind'))).toEqual(['proposal', 'grid_draft']);
    expect(within(others[0]!).getByRole('button', { name: 'Create task' })).toBeInTheDocument();

    // The first thing in the list, and #11 is not also under In review.
    const list = section.parentElement!;
    expect(list.firstElementChild).toBe(section);
    const review = screen.getAllByTestId('task-group').find((g) => g.getAttribute('data-status') === 'review')!;
    expect(within(review).getAllByTestId('task-row').map((r) => r.getAttribute('data-number'))).toEqual(['13']);
  });
});

describe('the chat’s row', () => {
  function aRow(sessionId: string, title: string): RestoreRow {
    return {
      sessionId, externalId: null, brand: 'claude', title, name: title, lastActiveAt: '2026-08-16T10:00:00.000Z',
      state: 'dormant', origin: 'app', projectId: 'p1', cwdHint: '/repo', folder: 'repo', branch: 'main',
    } as RestoreRow;
  }

  it('carries the badge a permission question would, in the words of what waits', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    rail = [aRow('s1', 'Has a review'), aRow('s2', 'Has two things'), aRow('s3', 'Has nothing')];
    waiting = [
      REVIEW,
      anItem({ ...PROPOSAL, sessionId: 's2' }),
      anItem({ ...AMEND, sessionId: 's2' }),
    ];
    const { ChatSidebar } = await import('@/workbench/chat-sidebar');
    render(<ChatSidebar projectId="p1" projectPath="/repo" openSessionId={null} onOpen={() => {}} />);

    const row = (title: string) => screen.getAllByTestId('restore-row').find((r) => r.textContent?.includes(title))!;
    await waitFor(() => expect(within(row('Has a review')).getByTestId('row-waiting')).toHaveTextContent('Review'));
    expect(within(row('Has two things')).getByTestId('row-waiting')).toHaveTextContent('Waiting for you');
    expect(within(row('Has nothing')).queryByTestId('row-waiting')).toBeNull();
    // Drawn like a permission question: the warning badge.
    expect(within(row('Has a review')).getByTestId('row-waiting').className).toMatch(/warning/);
    vi.unstubAllGlobals();
  });
});
