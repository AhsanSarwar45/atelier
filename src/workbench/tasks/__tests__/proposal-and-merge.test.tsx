import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { widget } from '@/workbench/chat-widgets';
import { offersMerge } from '@/workbench/composer-files';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { MergeBadge } from '@/workbench/tasks/task-card';
import type { TaskProposal, TaskWidget } from '@/workbench/tasks/types';

const answerProposal = vi.fn();
const proposal = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    act: vi.fn(),
    list: vi.fn(async () => []),
    get: vi.fn(),
    proposal: (...args: unknown[]) => proposal(...args),
    answerProposal: (...args: unknown[]) => answerProposal(...args),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo' }],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const draft: TaskProposal = {
  projectId: 'p1',
  id: 3,
  sessionId: 's1',
  type: 'bug',
  title: 'Fix the export',
  why: 'Exports drop the last line',
  plan: { symptom: 'Last line missing', reproduction: 'Export a chat' },
  status: 'pending',
  taskNumber: null,
  createdAt: 1,
  decidedAt: null,
};

const proposed: TaskWidget = { type: 'task', event: 'propose', proposal: draft };

beforeEach(() => {
  answerProposal.mockReset();
  proposal.mockReset();
  proposal.mockResolvedValue(draft);
});

describe('a proposed task', () => {
  it('is a task widget of its own shape', () => {
    expect(widget(proposed)).toBe(proposed);
    expect(widget({ ...proposed, task: makeTask() })).toBeNull();
    expect(widget({ type: 'task', event: 'create', task: makeTask(), proposal: draft })).toBeNull();
  });

  it('offers Create task, Just do it and Cancel while it waits', async () => {
    render(<ChatWidgetView widget={proposed} />);
    expect(screen.getByText('Fix the export')).toBeVisible();
    expect(screen.getByText('Exports drop the last line')).toBeVisible();
    for (const name of ['Create task', 'Just do it', 'Cancel']) expect(screen.getByRole('button', { name })).toBeEnabled();
    await waitFor(() => expect(proposal).toHaveBeenCalledWith('p1', 3));
  });

  it.each([
    ['Create task', 'create', { status: 'created', taskNumber: 9 }, 'Task #9 created'],
    ['Just do it', 'just_do_it', { status: 'just_do_it' }, 'Just doing it, without a task'],
    ['Cancel', 'cancel', { status: 'cancelled' }, 'Cancelled'],
  ] as const)('answers %s and shows what became of it', async (button, choice, after, words) => {
    answerProposal.mockResolvedValue({ proposal: { ...draft, ...after, decidedAt: 2 }, task: null, summary: '' });
    render(<ChatWidgetView widget={proposed} />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(screen.getByTestId('proposal-answer')).toHaveTextContent(words));
    expect(answerProposal).toHaveBeenCalledWith('p1', 3, choice);
    expect(screen.queryByTestId('proposal-actions')).toBeNull();
  });

  it('shows an answer given elsewhere, without buttons', async () => {
    proposal.mockResolvedValue({ ...draft, status: 'created', taskNumber: 4 });
    render(<ChatWidgetView widget={proposed} />);
    await waitFor(() => expect(screen.getByTestId('proposal-answer')).toHaveTextContent('Task #4 created'));
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
  });
});

describe('the merged badge', () => {
  const done = { status: 'done' as const, result: { summary: 'ok', commits: ['abc1234'] } };

  it.each([
    [true, 'Merged'],
    [false, 'Not merged'],
  ])('says %s as %s', (merged, words) => {
    render(<MergeBadge task={{ ...done, merged }} />);
    expect(screen.getByTestId('task-merged')).toHaveTextContent(words);
  });

  it.each([
    ['an unknown answer', { ...done, merged: null }],
    ['no commits', { ...done, result: { summary: 'ok', commits: [] }, merged: true }],
    ['an unfinished task', { ...done, status: 'review' as const, merged: true }],
  ])('is not drawn for %s', (_, task) => {
    const { container } = render(<MergeBadge task={task} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is drawn in the card of a done task', () => {
    render(<ChatWidgetView widget={{ type: 'task', event: 'done', task: makeTask({ ...done, merged: false }) }} />);
    expect(screen.getByTestId('task-merged')).toHaveTextContent('Not merged');
  });
});

describe('the Merge branch line of the @ menu', () => {
  it.each([
    ['m', 'all', true],
    ['MER', 'all', true],
    ['merge', 'all', true],
    ['', 'all', false],
    ['merged', 'all', false],
    ['me', 'task', false],
  ] as const)('%s in %s offers it: %s', (typed, scope, offered) => {
    expect(offersMerge(typed, scope)).toBe(offered);
  });
});
