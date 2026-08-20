import { describe, expect, it } from 'vitest';

import { byJob, jobTitle } from '@/workbench/cards-by-job';

/**
 * Folding a chat's cards onto their jobs.
 *
 * The rule the rail draws by, tested where it is decided rather than through the
 * browser: what the column shows is a browser check's business, and which card
 * stands for which pieces is this one's (bw-7ks.22.11).
 */

describe('the cards a chat touched, by job', () => {
  it('draws one chip for a job whose pieces are all the chat touched', () => {
    expect(byJob(['bw-uiyz.1', 'bw-uiyz.8', 'bw-uiyz.7'])).toEqual([
      { id: 'bw-uiyz', pieces: ['bw-uiyz.1', 'bw-uiyz.8', 'bw-uiyz.7'] },
    ]);
  });

  it('folds a piece into the job even when the chat touched the job itself', () => {
    expect(byJob(['bw-uiyz', 'bw-uiyz.4'])).toEqual([{ id: 'bw-uiyz', pieces: ['bw-uiyz.4'] }]);
    expect(byJob(['bw-uiyz.4', 'bw-uiyz'])).toEqual([{ id: 'bw-uiyz', pieces: ['bw-uiyz.4'] }]);
  });

  it('folds a piece of a piece into the same job', () => {
    // A job's own children are jobs in their turn; the chip names the one card a
    // reader recognises, and the depth is in the tooltip.
    expect(byJob(['bw-7ks.22.9', 'bw-7ks.21'])).toEqual([
      { id: 'bw-7ks', pieces: ['bw-7ks.22.9', 'bw-7ks.21'] },
    ]);
  });

  it('keeps the order the chat touched them in, and says each job once', () => {
    expect(byJob(['bw-b.1', 'bw-a.2', 'bw-b.3', 'bw-a.1']).map((j) => j.id)).toEqual(['bw-b', 'bw-a']);
  });

  it('drops a card the chat touched twice', () => {
    expect(byJob(['bw-a.1', 'bw-a.1'])).toEqual([{ id: 'bw-a', pieces: ['bw-a.1'] }]);
  });

  it('leaves a job that has no pieces alone', () => {
    expect(byJob(['bw-a', 'bw-b'])).toEqual([
      { id: 'bw-a', pieces: [] },
      { id: 'bw-b', pieces: [] },
    ]);
  });

  it('says nothing about pieces when there are none to say', () => {
    expect(jobTitle({ id: 'bw-a', pieces: [] })).toBe('Open bw-a');
  });

  it('counts the pieces and names them', () => {
    expect(jobTitle({ id: 'bw-a', pieces: ['bw-a.1'] })).toContain('1 piece of it: bw-a.1');
    expect(jobTitle({ id: 'bw-a', pieces: ['bw-a.1', 'bw-a.2'] })).toContain('2 pieces of it: bw-a.1, bw-a.2');
  });
});
