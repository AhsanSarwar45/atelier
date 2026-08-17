/**
 * How much of a job is done, once some of its pieces have been dropped.
 *
 * The manager's reading, 2026-08-17: dropped work is not part of the job. A job
 * of fourteen pieces with four dropped is a job of ten. Counting the dropped
 * ones in the total left bw-oio5 — every piece of it finished or dropped, none
 * standing — reading 10/14 and 71% forever, and because the button that
 * finishes a job is offered at 100% and nowhere else, it could never be signed
 * off from the manager's column.
 */
import { describe, expect, it } from 'vitest';

import { computeEpicProgress, progressPercent } from '@/lib/epic-parser';
import type { Bead, BeadStatus, Epic } from '@/types';

function piece(id: string, status: BeadStatus, deps?: string[]): Bead {
  return {
    id, title: id, status, priority: 0, issue_type: 'task', owner: 'someone',
    created_at: '', updated_at: '', comments: [], deps,
  };
}

/** A job made of the states given, in order, named .1 .2 .3 … */
function job(...states: BeadStatus[]): { epic: Epic; pieces: Bead[] } {
  const pieces = states.map((s, i) => piece(`job-1.${i + 1}`, s));
  return {
    epic: {
      id: 'job-1', title: 'A job', status: 'manager_review', priority: 0,
      issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '',
      comments: [], children: pieces.map((p) => p.id),
    },
    pieces,
  };
}

const many = (n: number, status: BeadStatus): BeadStatus[] => Array(n).fill(status);

const progressOf = (states: BeadStatus[]) => {
  const { epic, pieces } = job(...states);
  return computeEpicProgress(epic, pieces);
};

/** What the card draws — the app's own reading, not a second copy of it. */
const percentOf = progressPercent;

describe('what a job counts', () => {
  it('leaves dropped work out of the total, so a finished job reads all of it', () => {
    // bw-oio5 as it stands: fourteen pieces, ten finished, four dropped.
    const p = progressOf([...many(10, 'closed'), ...many(4, 'cancelled')]);
    expect(p.total).toBe(10);
    expect(p.completed).toBe(10);
    expect(p.dropped).toBe(4);
    expect(percentOf(p)).toBe(100);
  });

  it('still counts the work that is left', () => {
    const p = progressOf([
      ...many(6, 'closed'), ...many(2, 'cancelled'),
      'in_progress', 'open',
    ]);
    expect(p.total).toBe(8);
    expect(p.completed).toBe(6);
    expect(p.inProgress).toBe(1);
    expect(p.dropped).toBe(2);
    expect(percentOf(p)).toBe(75);
  });

  it('reads a job whose every piece was dropped as nothing done, not as finished', () => {
    // Nothing was finished there. Such a job is one to drop, not one to sign
    // off, and the screen offers the finish at a hundred and nowhere else.
    const p = progressOf(many(3, 'cancelled'));
    expect(p.total).toBe(0);
    expect(p.completed).toBe(0);
    expect(p.dropped).toBe(3);
    expect(percentOf(p)).toBe(0);
  });

  it('reads a job with no pieces at all as nothing, not as finished', () => {
    const epic: Epic = {
      id: 'job-2', title: 'An empty job', status: 'open', priority: 0,
      issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '',
      comments: [], children: [],
    };
    const p = computeEpicProgress(epic, []);
    expect(p.total).toBe(0);
    expect(p.dropped).toBe(0);
    expect(percentOf(p)).toBe(0);
  });

  it('never reads a hundred while a piece is still standing', () => {
    // 199 of 200 rounds to a hundred, and a hundred is what draws the full
    // green bar and offers the sign-off.
    const p = progressOf([...many(199, 'closed'), 'open']);
    expect(p.total).toBe(200);
    expect(p.completed).toBe(199);
    expect(percentOf(p)).toBe(99);
  });

  it('reads a hundred the moment the last piece closes', () => {
    const p = progressOf(many(200, 'closed'));
    expect(percentOf(p)).toBe(100);
  });

  it('counts a job waiting to be read and a job waiting on the manager as unfinished', () => {
    // Neither is done: the work is standing until the board says otherwise.
    const p = progressOf(['closed', 'inreview', 'manager_review']);
    expect(p.total).toBe(3);
    expect(p.completed).toBe(1);
    expect(percentOf(p)).toBe(33);
  });
});

describe('what a job counts as blocked', () => {
  it('does not count a piece whose only blocker was dropped', () => {
    const dropped = piece('job-3.1', 'cancelled');
    const waiting = piece('job-3.2', 'open', [dropped.id]);
    const epic: Epic = {
      id: 'job-3', title: 'A job', status: 'open', priority: 0,
      issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '',
      comments: [], children: [dropped.id, waiting.id],
    };
    const p = computeEpicProgress(epic, [dropped, waiting]);
    expect(p.blocked).toBe(0);
    expect(p.total).toBe(1);
    expect(p.dropped).toBe(1);
  });

  it('counts a piece waiting on work that is still standing', () => {
    const blocker = piece('job-4.1', 'in_progress');
    const waiting = piece('job-4.2', 'open', [blocker.id]);
    const epic: Epic = {
      id: 'job-4', title: 'A job', status: 'open', priority: 0,
      issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '',
      comments: [], children: [blocker.id, waiting.id],
    };
    expect(computeEpicProgress(epic, [blocker, waiting]).blocked).toBe(1);
  });

  it('never counts a dropped piece as blocked, whatever it waited on', () => {
    const blocker = piece('job-5.1', 'open');
    const abandoned = piece('job-5.2', 'cancelled', [blocker.id]);
    const epic: Epic = {
      id: 'job-5', title: 'A job', status: 'open', priority: 0,
      issue_type: 'epic', owner: 'someone', created_at: '', updated_at: '',
      comments: [], children: [blocker.id, abandoned.id],
    };
    expect(computeEpicProgress(epic, [blocker, abandoned]).blocked).toBe(0);
  });
});
