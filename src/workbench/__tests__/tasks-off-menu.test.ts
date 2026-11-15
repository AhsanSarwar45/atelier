/** The composer's @ menu offers no task or grid lines while tasks are off. */
import { describe, expect, it } from 'vitest';

import { offersAudit, offersMatrix, offersMerge, offersNewTask } from '@/workbench/composer-files';

describe('the @ menu with tasks turned off', () => {
  it('offers no @task, @merge, @matrix or @audit', () => {
    expect(offersNewTask('ta', 'all', false)).toBe(false);
    expect(offersMerge('me', 'all', false)).toBe(false);
    expect(offersMatrix('ma', 'all', false)).toBe(false);
    expect(offersAudit('au', 'all', false)).toBe(false);
  });

  it('offers them while tasks are on', () => {
    expect(offersNewTask('ta', 'all', true)).toBe(true);
    expect(offersMerge('me', 'all', true)).toBe(true);
    expect(offersMatrix('ma', 'all', true)).toBe(true);
    expect(offersAudit('au', 'all', true)).toBe(true);
  });
});
