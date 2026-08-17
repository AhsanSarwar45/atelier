/**
 * What the panel says about a job, beside what its card says.
 *
 * The two used to disagree: the panel counted every piece a job held, including
 * the ones it dropped, while the card counted the pieces that count. One job,
 * two sizes. And the panel drew dropped work in the related list like live
 * work, which is the same reading gone wrong one level down.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { BeadDetail } from '../bead-detail';
import type { Bead, BeadStatus } from '@/types';

vi.mock('@/lib/cli', () => ({
  closeBead: vi.fn().mockResolvedValue(undefined),
  updateBeadStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/api', () => ({
  git: { prStatus: vi.fn().mockResolvedValue({ pr: null }), worktreeStatus: vi.fn() },
  beads: { get: vi.fn() },
}));

const piece = (id: string, status: BeadStatus, extra: Partial<Bead> = {}): Bead => ({
  id, title: `piece ${id}`, status, priority: 0, issue_type: 'task',
  owner: 'someone', created_at: '', updated_at: '', comments: [], ...extra,
});

/** A job of `done` finished pieces and `dropped` dropped ones. */
function job(done: number, dropped: number) {
  const pieces = [
    ...Array.from({ length: done }, (_, i) => piece(`job-1.d${i}`, 'closed')),
    ...Array.from({ length: dropped }, (_, i) => piece(`job-1.x${i}`, 'cancelled')),
  ];
  const epic: Bead = {
    ...piece('job-1', 'manager_review'), title: 'A job', issue_type: 'epic',
    children: pieces.map(p => p.id),
  };
  return { epic, pieces };
}

const draw = (bead: Bead, allBeads: Bead[]) =>
  render(
    <BeadDetail
      bead={bead}
      allBeads={allBeads}
      open
      onOpenChange={vi.fn()}
      onChildClick={vi.fn()}
      projectPath="/test/project"
    />
  );

describe('the size the panel states', () => {
  it('counts the pieces that count, and says what was dropped', () => {
    const { epic, pieces } = job(10, 4);
    draw(epic, [epic, ...pieces]);
    expect(screen.getByText(/Subtasks \(10 · 4 dropped\)/)).toBeInTheDocument();
  });

  it('states a plain count when nothing was dropped', () => {
    const { epic, pieces } = job(3, 0);
    draw(epic, [epic, ...pieces]);
    expect(screen.getByText(/Subtasks \(3\)/)).toBeInTheDocument();
  });
});

describe('the related list', () => {
  it('strikes dropped work through, the same as finished work', () => {
    const finished = piece('other-1', 'closed');
    const abandoned = piece('other-2', 'cancelled');
    const bead = piece('job-2', 'open', { relates_to: [finished.id, abandoned.id] });
    const { container } = draw(bead, [bead, finished, abandoned]);
    const titles = Array.from(container.querySelectorAll('span'))
      .filter(s => /^piece other-/.test(s.textContent ?? ''));
    expect(titles.length).toBe(2);
    for (const t of titles) {
      expect(t.className, t.textContent ?? '').toMatch(/line-through/);
    }
  });

  it('leaves work that is still standing undrawn as done', () => {
    const live = piece('other-3', 'in_progress');
    const bead = piece('job-3', 'open', { relates_to: [live.id] });
    const { container } = draw(bead, [bead, live]);
    const title = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent === 'piece other-3');
    expect(title?.className).not.toMatch(/line-through/);
  });
});
