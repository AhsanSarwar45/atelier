/**
 * A long chat keeps only the rows near the screen mounted, so a proposal card
 * is unmounted and drawn again as it scrolls. One that was read once must
 * draw its last known answer at once, not the stored waiting copy with its
 * buttons, which changes its height and makes a chat held at the end jump.
 */
import { render, screen, waitFor } from '@testing-library/react';
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

const proposed: TaskWidget = { type: 'task', event: 'propose', proposal: draft };

beforeEach(() => {
  answerProposal.mockReset();
  proposal.mockReset().mockResolvedValue({ ...draft, status: 'cancelled', decidedAt: 2 });
});

describe('a proposal card drawn again', () => {
  it('draws the answer it already read, not the stored waiting copy', async () => {
    const first = render(<ChatWidgetView widget={proposed} />);
    await waitFor(() => expect(screen.getByTestId('proposal-answer')).toHaveTextContent('Cancelled'));
    first.unmount();

    render(<ChatWidgetView widget={proposed} />);
    expect(screen.queryByTestId('proposal-actions')).toBeNull();
    expect(screen.getByTestId('proposal-answer')).toHaveTextContent('Cancelled');
  });
});
