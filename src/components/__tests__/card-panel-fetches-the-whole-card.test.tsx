import type { ReactNode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bead } from '@/types';

// The board list is read brief, so the panel fetches the open card whole and
// draws the list's copy until it lands (bw-fbzd.7).
let listed: Bead[] = [];
const card = vi.fn();

vi.mock('@/app/project/board-cards', () => ({
  useBoardCards: () => ({ beads: listed, ticketNumbers: new Map(), refresh: async () => {} }),
}));
vi.mock('@/lib/api', () => ({ beads: { card: (...args: unknown[]) => card(...args) } }));
vi.mock('@/hooks/use-worktree-statuses', () => ({ useWorktreeStatuses: () => ({ statuses: {} }) }));
vi.mock('@/components/bead-detail', () => ({
  PANEL_SLIDE_MS: 0,
  BeadDetail: ({ bead, children }: { bead: Bead; children: ReactNode }) => (
    <div>
      <p data-testid="title">{bead.title}</p>
      <p data-testid="status">{bead.status}</p>
      <p data-testid="notes">{bead.notes ?? ''}</p>
      {children}
    </div>
  ),
}));
vi.mock('@/components/comment-list', () => ({
  CommentList: ({ comments }: { comments: unknown[] }) => <p data-testid="comments">{comments.length}</p>,
}));
vi.mock('@/components/activity-timeline', () => ({ ActivityTimeline: () => null }));
vi.mock('@/workbench/card-chats', () => ({ CardChats: () => null }));
vi.mock('@/workbench/start-from-card', () => ({
  StartFromCard: ({ waiting }: { waiting?: boolean }) => <p data-testid="waiting">{String(waiting)}</p>,
}));

import { CardPanel } from '@/components/card-panel';

const brief = (over: Partial<Bead> = {}): Bead => ({
  id: 'bw-1', title: 'Title', status: 'open', priority: 2, issue_type: 'task', owner: '',
  created_at: '', updated_at: '2026-09-01T00:00:00Z', comments: [], comment_count: 2, ...over,
});

const panel = () => (
  <CardPanel cardId="bw-1" projectId="p" projectPath="/project" onClose={() => {}} onOpenCard={() => {}} />
);

describe('the card panel over a brief board', () => {
  beforeEach(() => {
    card.mockReset();
    listed = [brief()];
  });

  it('draws the list copy at once, then the whole card over it', async () => {
    let land: (value: unknown) => void = () => {};
    card.mockReturnValue(new Promise((resolve) => { land = resolve; }));

    render(panel());
    expect(screen.getByTestId('title')).toHaveTextContent('Title');
    expect(screen.getByTestId('waiting')).toHaveTextContent('true');
    expect(screen.queryByTestId('comments')).toBeNull();
    expect(card).toHaveBeenCalledWith('/project', 'bw-1');

    land({ bead: { ...brief(), status: 'open', notes: 'the notes', comments: [{}, {}] }, source: 'cli' });
    await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('the notes'));
    expect(screen.getByTestId('comments')).toHaveTextContent('2');
    expect(screen.getByTestId('waiting')).toHaveTextContent('false');
  });

  it('fetches again when the list copy changes, and keeps the list status meanwhile', async () => {
    card.mockResolvedValue({ bead: { ...brief(), notes: 'first' } });
    const { rerender } = render(panel());
    await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('first'));

    card.mockResolvedValue({ bead: { ...brief(), status: 'closed', notes: 'second' } });
    listed = [brief({ status: 'closed', updated_at: '2026-09-02T00:00:00Z' })];
    rerender(panel());
    expect(screen.getByTestId('status')).toHaveTextContent('closed');
    await waitFor(() => expect(screen.getByTestId('notes')).toHaveTextContent('second'));
    expect(card).toHaveBeenCalledTimes(2);
  });

  it('keeps drawing the list copy when the card cannot be fetched', async () => {
    card.mockRejectedValue(new Error('gone'));
    listed = [brief({ comment_count: 0 })];
    render(panel());
    await waitFor(() => expect(screen.getByTestId('waiting')).toHaveTextContent('false'));
    expect(screen.getByTestId('title')).toHaveTextContent('Title');
    expect(screen.getByTestId('comments')).toHaveTextContent('0');
  });
});
