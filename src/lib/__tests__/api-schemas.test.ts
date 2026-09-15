import { describe, expect, it } from 'vitest';

import {
  BeadsResponseSchema,
  CardResponseSchema,
  CardStatusesResponseSchema,
  WorktreeStatusSchema,
} from '@/lib/api-schemas';

const card = {
  id: 'bw-1',
  title: 'A card',
  status: 'open',
  description: null,
  priority: 2,
  labels: ['cancelled'],
  comments: [{ id: 3, issue_id: 'bw-1', author: 'someone', text: 'hi', created_at: '2026-09-15T00:00:00Z' }],
};

describe('checking what the server answered', () => {
  it('lets a whole board, a brief board and extra fields through, and hands the value back', () => {
    const whole = { beads: [card], source: 'jsonl' };
    expect(BeadsResponseSchema.parse(whole)).toBe(whole);
    const { comments: _left, ...brief } = card;
    expect(() => BeadsResponseSchema.parse({ beads: [{ ...brief, comment_count: 1, something_new: true }] })).not.toThrow();
  });

  it('refuses a card with a field of the wrong kind, and says where', () => {
    const bad = { beads: [card, { ...card, id: 'bw-2', priority: 'high' }] };
    expect(() => BeadsResponseSchema.parse(bad)).toThrow('beads[1].priority: expected number, got string');
  });

  it('refuses an answer that is not the shape at all', () => {
    expect(() => BeadsResponseSchema.parse({ beads: 'nope' })).toThrow('beads: expected array');
    expect(() => BeadsResponseSchema.parse(null)).toThrow('(root): expected object, got null');
    expect(() => BeadsResponseSchema.parse({ beads: [], source: null })).toThrow('source: expected string');
  });

  it('takes a comment id as a number or a string, and nothing else', () => {
    const withId = (id: unknown) => ({ bead: { ...card, comments: [{ ...card.comments[0], id }] } });
    expect(() => CardResponseSchema.parse(withId('c-1'))).not.toThrow();
    expect(() => CardResponseSchema.parse(withId(false))).toThrow('bead.comments[0].id: expected number or string');
  });

  it('checks statuses and a worktree the way they are sent', () => {
    expect(() => CardStatusesResponseSchema.parse({ beads: [{ id: 'bw-1', status: 'open', updated_at: null, dropped: true }] })).not.toThrow();
    expect(() => CardStatusesResponseSchema.parse({ beads: [{ id: 'bw-1', status: 'open', dropped: null }] })).toThrow('dropped: expected boolean');
    const worktree = { exists: true, worktree_path: null, branch: 'bw-1', ahead: 0, behind: 2, dirty: false, last_modified: null };
    expect(() => WorktreeStatusSchema.parse(worktree)).not.toThrow();
    const { branch: _missing, ...noBranch } = worktree;
    expect(() => WorktreeStatusSchema.parse(noBranch)).toThrow('branch: expected string, got undefined');
  });
});
