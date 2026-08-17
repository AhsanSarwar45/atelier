/**
 * Which column offers the button that finishes a job.
 *
 * Manager Review is the one column no session may move a card out of
 * (corsetta `scripts/hooks/board-status-gate.py`, which tells a session the
 * manager signs it on his own screen), so the screen is the only place a job
 * there can be finished. Agent Review must offer nothing: a job waiting to be
 * read has been signed by nobody yet, and a finish offered there is how
 * unsigned work reached Done.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { EpicCard } from '../epic-card';
import type { Bead, BeadStatus, Epic } from '@/types';

vi.mock('@/lib/cli', () => ({ closeBead: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', () => ({ git: { prStatus: vi.fn() } }));

const FINISH = /mark done/i;

const child: Bead = {
  id: 'test-1.1', title: 'A piece of it', status: 'closed', priority: 0,
  issue_type: 'task', owner: 'someone', created_at: '', updated_at: '', comments: [],
};

const epicIn = (status: BeadStatus): Epic => ({
  id: 'test-1', title: 'A job', status, priority: 0,
  issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '', comments: [],
  children: [child.id],
});

const draw = (status: BeadStatus) =>
  render(
    <EpicCard
      epic={epicIn(status)}
      allBeads={[child]}
      onSelect={vi.fn()}
      onChildClick={vi.fn()}
      projectPath="/test/project"
    />
  );

/** A job of `done` finished pieces and `dropped` dropped ones, and nothing else. */
const withPieces = (status: BeadStatus, done: number, dropped: number) => {
  const pieces: Bead[] = [
    ...Array.from({ length: done }, (_, i) => ({
      ...child, id: `test-1.d${i}`, status: 'closed' as BeadStatus,
    })),
    ...Array.from({ length: dropped }, (_, i) => ({
      ...child, id: `test-1.x${i}`, status: 'cancelled' as BeadStatus,
    })),
  ];
  return {
    epic: { ...epicIn(status), children: pieces.map((p) => p.id) },
    allBeads: pieces,
    onSelect: vi.fn(),
    onChildClick: vi.fn(),
    projectPath: '/test/project',
  };
};

describe('the button that finishes a job', () => {
  it('is drawn on a job waiting for the manager', () => {
    draw('manager_review');
    expect(screen.getByRole('button', { name: FINISH })).toBeInTheDocument();
  });

  it('is not drawn on a job still waiting to be read', () => {
    draw('inreview');
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is not drawn on a job nobody has started', () => {
    draw('open');
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is not drawn while a piece of the job is still open', () => {
    const unfinished: Bead = { ...child, id: 'test-1.2', status: 'in_progress' };
    render(
      <EpicCard
        epic={{ ...epicIn('manager_review'), children: [child.id, unfinished.id] }}
        allBeads={[child, unfinished]}
        onSelect={vi.fn()}
        onChildClick={vi.fn()}
        projectPath="/test/project"
      />
    );
    expect(screen.queryByRole('button', { name: FINISH })).toBeNull();
  });

  it('is drawn when every piece left is finished and the rest were dropped', () => {
    // bw-oio5's shape: ten finished, four dropped, none standing. Counting the
    // dropped ones in the total held it at 71%, and the button never appeared.
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getByRole('button', { name: FINISH })).toBeInTheDocument();
  });
});

describe('what a card says it is made of', () => {
  it('counts only the pieces still part of the job', () => {
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getByText(/10\/10/)).toBeInTheDocument();
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });

  it('says how many of its pieces were dropped', () => {
    render(<EpicCard {...withPieces('manager_review', 10, 4)} />);
    expect(screen.getByText(/4 dropped/)).toBeInTheDocument();
  });

  it('says nothing about dropped work when none was dropped', () => {
    render(<EpicCard {...withPieces('open', 2, 0)} />);
    expect(screen.queryByText(/dropped/)).toBeNull();
  });
});
