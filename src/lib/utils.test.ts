import { describe, expect, it } from 'vitest';

import { projectDir } from './utils';

describe('projectDir', () => {
  it('is the path itself for a project kept on disk', () => {
    expect(projectDir({ path: '/home/user/corsetta' })).toBe('/home/user/corsetta');
  });

  it('is empty for no project at all', () => {
    expect(projectDir(null)).toBe('');
    expect(projectDir(undefined)).toBe('');
  });
});
