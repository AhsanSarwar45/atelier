/**
 * The owner can ask for changes to a proposal instead of only taking or
 * dropping it, and a proposal the chat replaced with a newer one folds to a
 * line (docs/tasks.md, "Proposals").
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
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

const proposed = (over: Partial<TaskProposal> = {}): TaskWidget => ({ type: 'task', event: 'propose', proposal: { ...draft, ...over } });

const note = 'Make it work for every export format, not just this one';

beforeEach(() => {
  answerProposal.mockReset();
  proposal.mockReset();
  proposal.mockResolvedValue(draft);
});

describe('asking for changes to a proposal', () => {
  it('sends the owner\'s note and shows it on the card', async () => {
    answerProposal.mockResolvedValue({ proposal: { ...draft, status: 'changes_requested', note, decidedAt: 2 }, task: null, summary: '' });
    render(<ChatWidgetView widget={proposed()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change?' }), { target: { value: note } });
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId('proposal-answer')).toHaveTextContent(`Changes requested: ${note}`));
    expect(answerProposal).toHaveBeenCalledWith('p1', 3, 'changes', note);
    expect(screen.queryByTestId('proposal-actions')).toBeNull();
  });
});

describe('a proposal replaced by a newer one', () => {
  it('folds to one line with no buttons and no plan', async () => {
    proposal.mockResolvedValue({ ...draft, status: 'superseded', decidedAt: 2 });
    render(<ChatWidgetView widget={proposed({ status: 'superseded', decidedAt: 2 })} />);
    expect(screen.getByTestId('proposal-answer')).toHaveTextContent('Replaced by a newer proposal');
    expect(screen.queryByTestId('proposal-actions')).toBeNull();
    expect(screen.queryByText('Last line missing')).toBeNull();
  });
});
