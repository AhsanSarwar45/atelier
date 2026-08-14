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
});
